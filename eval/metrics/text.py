"""Text normalisation, word error rate (overall and on domain terms) and token-overlap similarity."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable

from .base import Ratio

_NON_WORD = re.compile(r"[^a-z0-9']+")

# Utility terminology whose recognition matters most. Multi-word terms are matched as token sequences.
DEFAULT_DOMAIN_TERMS = [
    "lv", "hv", "ewp", "mewp", "earthing", "earth", "earths", "earthed", "isolation", "isolate", "isolated",
    "isolations", "isolator", "loto", "lock out", "tag out", "test before touch", "prove dead", "de energised",
    "energised", "live", "mains", "neutral", "conductor", "conductors", "service fuse", "fuse", "fuses",
    "pillar", "padmount", "substation", "transformer", "pole", "crossarm", "cross arm", "switching",
    "access permit", "exclusion zone", "no go zone", "approach distance", "spotter", "crane", "outriggers",
    "dial before you dig", "byda", "potholing", "cable locator", "excavation", "traffic control", "tcp",
    "chainsaw", "vegetation", "arc flash", "arc rated", "kv", "11kv", "22kv", "415", "240", "volts",
]

STOPWORDS = {
    "a", "an", "the", "of", "to", "at", "in", "on", "and", "or", "is", "are", "be", "for", "by", "with",
    "it", "its", "it's", "we", "we'll", "we're", "our", "this", "that", "there", "from", "up", "will", "um", "uh",
}


def normalise(text: str) -> str:
    return " ".join(tokens(text))


def tokens(text: str) -> list[str]:
    cleaned = _NON_WORD.sub(" ", text.lower().replace("’", "'"))
    return [t.strip("'") for t in cleaned.split() if t.strip("'")]


def content_tokens(text: str) -> list[str]:
    return [t for t in tokens(text) if t not in STOPWORDS]


def align(ref: list[str], hyp: list[str]) -> list[tuple[str, int | None, int | None]]:
    """Levenshtein alignment. Returns ops ("ok"|"sub"|"del"|"ins", ref_index, hyp_index)."""
    n, m = len(ref), len(hyp)
    dist = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dist[i][0] = i
    for j in range(m + 1):
        dist[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            dist[i][j] = min(dist[i - 1][j - 1] + cost, dist[i - 1][j] + 1, dist[i][j - 1] + 1)
    ops: list[tuple[str, int | None, int | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dist[i][j] == dist[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1):
            ops.append(("ok" if ref[i - 1] == hyp[j - 1] else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i > 0 and dist[i][j] == dist[i - 1][j] + 1:
            ops.append(("del", i - 1, None))
            i -= 1
        else:
            ops.append(("ins", None, j - 1))
            j -= 1
    ops.reverse()
    return ops


def _domain_positions(ref: list[str], terms: Iterable[str]) -> set[int]:
    positions: set[int] = set()
    for term in terms:
        seq = tokens(term)
        if not seq:
            continue
        for start in range(len(ref) - len(seq) + 1):
            if ref[start:start + len(seq)] == seq:
                positions.update(range(start, start + len(seq)))
    return positions


def word_error_rates(ref_text: str, hyp_text: str, domain_terms: Iterable[str]) -> tuple[Ratio, Ratio, list[str]]:
    """(overall WER, domain-term WER, misrecognised domain terms).

    Domain-term WER counts substitutions and deletions of reference tokens that belong to a domain
    term; insertions have no reference position so they only count towards the overall WER.
    """
    ref, hyp = tokens(ref_text), tokens(hyp_text)
    ops = align(ref, hyp)
    errors = sum(1 for op, _, _ in ops if op != "ok")
    domain = _domain_positions(ref, domain_terms)
    domain_errors = [ref[i] for op, i, _ in ops if op in ("sub", "del") and i is not None and i in domain]
    return Ratio(errors, len(ref)), Ratio(len(domain_errors), len(domain)), domain_errors


def token_overlap(a: str, b: str) -> float:
    """F1 of content-token multisets: a cheap, deterministic stand-in for semantic similarity."""
    ta, tb = Counter(content_tokens(a)), Counter(content_tokens(b))
    if not ta or not tb:
        return 1.0 if not ta and not tb else 0.0
    common = sum((ta & tb).values())
    if not common:
        return 0.0
    precision, recall = common / sum(tb.values()), common / sum(ta.values())
    return 2 * precision * recall / (precision + recall)


def quote_in_text(quote: str, text: str, min_token_share: float = 0.9) -> bool:
    """Is an evidence quote supported by the text? Normalised substring, or nearly all of its tokens."""
    q, t = normalise(quote), normalise(text)
    if not q:
        return False
    if q in t:
        return True
    q_tokens = Counter(tokens(quote))
    t_tokens = Counter(tokens(text))
    return sum((q_tokens & t_tokens).values()) / sum(q_tokens.values()) >= min_token_share
