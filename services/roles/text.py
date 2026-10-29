"""Deterministic language helpers: clause splitting, library phrase matching, negation and tense.

Tuned for how Australian field crews talk ("righto", "nah, no dramas", "we've pulled the fuses").
Used by the heuristic roles and as a recall safety net behind the LLM analyst.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from packages.schemas import HazardLibrary

# --- Normalisation & clauses -----------------------------------------------------------------

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "`": "'"})
_SPLIT_RE = re.compile(
    r"(?<=[.!?;])\s+"  # sentence ends
    r"|\s*;\s*"
    r"|,?\s+(?=(?:but|and then|then|after that|once that's done|once that is done|so we|although|however|"
    r"whereas|plus)\b)",
    re.IGNORECASE,
)
_QUESTION_START = re.compile(
    r"^(?:is|are|any|anyone|anybody|do|does|did|has|have|can|could|will|what|where|who|how|got any|is there|"
    r"are there)\b")


def normalise(text: str) -> str:
    """Lowercase, unify apostrophes, hyphens/slashes to spaces, keep commas as scope markers."""
    t = text.translate(_APOSTROPHES).lower()
    t = re.sub(r"[-/]", " ", t)
    t = re.sub(r"[^a-z0-9', ]+", " ", t)
    t = re.sub(r"\s*,\s*", " , ", t)
    return re.sub(r"\s+", " ", t).strip()


@dataclass(frozen=True)
class Clause:
    text: str  # original wording (for quotes and value extraction)
    norm: str  # normalised (for matching)

    @property
    def is_question(self) -> bool:
        return self.text.rstrip().endswith("?") or bool(_QUESTION_START.match(self.norm))


def split_clauses(text: str) -> list[Clause]:
    parts = [p.strip(" ,") for p in _SPLIT_RE.split(text.translate(_APOSTROPHES)) if p and p.strip(" ,")]
    return [Clause(p, normalise(p)) for p in parts if normalise(p)]


def tokens(norm: str) -> list[str]:
    return norm.split()


# --- Phrase matching -------------------------------------------------------------------------

KINDS = ("hazard", "control", "site_condition", "task_type")


@dataclass(frozen=True)
class Match:
    kind: str
    code: str
    keyword: str
    start: int  # char offsets in the normalised clause
    end: int


class PhraseMatcher:
    """Whole-word, longest-first matching of library keywords (with optional plural ``s``/``es``).

    Matching is per kind, so "overhead lines" can be both a hazard and a site condition, while
    within a kind the longest phrase wins ("isolate the solar" beats "isolate").
    """

    def __init__(self, library: HazardLibrary):
        self._lookup: dict[str, dict[str, list[str]]] = {k: {} for k in KINDS}
        sources = {
            "hazard": [(h.code, h.keywords) for h in library.hazards],
            "control": [(c.code, c.keywords) for c in library.controls],
            "site_condition": [(s.code, s.keywords) for s in library.site_conditions],
            "task_type": [(t.code, t.keywords) for t in library.task_types],
        }
        self._patterns: dict[str, re.Pattern[str]] = {}
        for kind, entries in sources.items():
            for code, keywords in entries:
                for kw in keywords:
                    key = normalise(kw)
                    if key:
                        codes = self._lookup[kind].setdefault(key, [])
                        if code not in codes:
                            codes.append(code)
            alternatives = sorted(self._lookup[kind], key=len, reverse=True)
            body = "|".join(re.escape(k).replace(r"\ ", r"\s+") + ("(?:s|es)?" if k[-1].isalpha() else "")
                            for k in alternatives)
            self._patterns[kind] = re.compile(rf"(?<![a-z0-9'])(?:{body})(?![a-z0-9])")

    def _codes(self, kind: str, text: str) -> tuple[str, list[str]]:
        key = re.sub(r"\s+", " ", text)
        table = self._lookup[kind]
        for candidate in (key, key.removesuffix("es"), key.removesuffix("s")):
            if candidate in table:
                return candidate, table[candidate]
        return key, []

    def find(self, norm: str, kinds: tuple[str, ...] = KINDS) -> list[Match]:
        out: list[Match] = []
        for kind in kinds:
            for m in self._patterns[kind].finditer(norm):
                keyword, codes = self._codes(kind, m.group(0))
                out.extend(Match(kind, code, keyword, m.start(), m.end()) for code in codes)
        return out


_MATCHERS: dict[int, tuple[HazardLibrary, PhraseMatcher]] = {}


def matcher(library: HazardLibrary) -> PhraseMatcher:
    """Compiled matcher per library instance (the library itself is cached process-wide)."""
    cached = _MATCHERS.get(id(library))
    if cached is None or cached[0] is not library:
        cached = (library, PhraseMatcher(library))
        _MATCHERS[id(library)] = cached
    return cached[1]


# --- Negation --------------------------------------------------------------------------------

NEGATION_CUES = frozenset({
    "no", "not", "nobody", "nobody's", "noone", "none", "never", "without", "isn't", "aren't", "wasn't",
    "weren't", "won't", "don't", "doesn't", "didn't", "haven't", "hasn't", "nah", "nothing", "neither", "nor",
    "there's no", "can't", "cannot",
})
SCOPE_BREAKERS = frozenset({",", "but", "and", "although", "though", "however", "except", "so", "because",
                            "while", "whereas", "plus"})
NEGATION_WINDOW = 5
# Phrases containing a negation word that do not negate what follows.
_PSEUDO_NEGATION = re.compile(
    r"\b(?:no dramas|no worries|no problem|no probs|no doubt|not only|no matter|not just|not sure if|"
    r"don't forget|never forget|not without)\b")
# Safety instructions: "make sure nobody's under the bucket" asserts the hazard, it doesn't deny it.
_INSTRUCTION = re.compile(r"\b(?:make sure|ensure|keep|don't let|do not let|never let|watch out|look out|"
                          r"careful|be aware|mindful)\b")
_POST_NEGATION = re.compile(
    r"^(?:'s)?\s*(?:(?:is|are|was|were|'s)\s+not|isn't|aren't|wasn't|weren't|not)\s+(?:an?\s+|any\s+)?"
    r"(?:issue|problem|worry|concern|present|here|there|around|about|on site|a thing)\b")


def is_negated(norm: str, start: int, end: int) -> bool:
    """Explicit negation of the phrase at ``norm[start:end]`` ("no solar", "traffic isn't an issue")."""
    before = _PSEUDO_NEGATION.sub(" ", norm[:start])
    if _INSTRUCTION.search(before):
        return False
    window: list[str] = []
    for tok in reversed(before.split()):
        if tok in SCOPE_BREAKERS or len(window) >= NEGATION_WINDOW:
            break
        window.append(tok)
    if any(tok in NEGATION_CUES or tok.endswith("n't") for tok in window):
        return True
    return bool(_POST_NEGATION.match(norm[end:end + 60].strip()))


# --- Tense (control status) ------------------------------------------------------------------

_PLANNED = re.compile(
    r"\b(?:will|'ll|we'll|i'll|going to|gonna|need to|needs to|have to|has to|got to|gotta|should|must|"
    r"before we|make sure|let's|plan is|planning to|about to|yet to|still to|then)\b|\bwe'll\b|\bi'll\b")
_IN_PLACE = re.compile(
    r"\b(?:already|we've|i've|they've|we have|has been|have been|is done|are done|done|in place|is set up|"
    r"are set up|are up|is up|are out|are on|is on|are fitted|is fitted|was issued|has been issued|got the|"
    r"we got|we've got|is isolated|it's isolated|are isolated|is earthed|are earthed|is locked|are locked|"
    r"is tagged|are tagged|is tested|tested|proved|proven|isolated|earthed|pulled|removed|installed|applied|"
    r"set out|completed|checked|signed on)\b")


def control_status(norm: str) -> str:
    """``in_place`` when the crew says it is done, otherwise ``planned``."""
    if _PLANNED.search(norm):
        return "planned"
    return "in_place" if _IN_PLACE.search(norm) else "planned"


# --- Off-topic -------------------------------------------------------------------------------

_OFF_TOPIC = re.compile(
    r"\b(?:footy|football|nrl|afl|rugby|cricket|the game|grand final|state of origin|swans|broncos|tigers|"
    r"weekend|pub|beers?|schooner|coffee|maccas|kebab|lunch order|smoko order|barbie|bbq|fishing|holiday|"
    r"netflix|telly|the races|the punt|tipping|missus|girlfriend|boyfriend|birthday|footy tips|the kids' "
    r"party|fantasy league|golf)\b")


def is_off_topic(norm: str) -> bool:
    return bool(_OFF_TOPIC.search(norm))


_AFFIRMATIVE = re.compile(r"^(?:yeah|yep|yes|yup|correct|sure is|sure are|there is|there are|afraid so|"
                          r"too right|definitely|affirmative)\b")
_NEGATIVE = re.compile(r"^(?:nah|no|nope|none|not that i|there isn't|there's not|there aren't|nothing|"
                       r"negative|not today)\b")


def yes_no(norm: str) -> bool | None:
    """Classify a short reply: True (yes), False (no) or None (neither)."""
    if _NEGATIVE.match(norm):
        return False
    if _AFFIRMATIVE.match(norm):
        return True
    return None
