"""Short spoken questions for gaps (max ~20 words), shared by the verifier and the voice prompter."""

from __future__ import annotations

import re

from packages.schemas import ControlType, GapKind, HazardLibrary

_ACRONYMS = {"lv": "LV", "hv": "HV", "ewp": "EWP", "sf6": "SF6", "uv": "UV"}
_FIELD_QUESTIONS = {
    "/job/title": "What's the job today?",
    "/job/location": "What's the address or pole number for this job?",
    "/emergency/muster_point": "Where's the muster point today?",
    "/emergency/nearest_hospital": "Which hospital is closest if someone gets hurt?",
    "/emergency/first_aider": "Who's the first aider on this job?",
    "/emergency/communications": "How are we communicating today, radio or mobile?",
    "/crew": "Can everyone tap in on the app so I know who's on the crew?",
    "/hazards": "What hazards are we dealing with on this job?",
}
MAX_WORDS = 20


def _spoken(name: str) -> str:
    """"Contact with live LV conductors" -> "work near live LV conductors"."""
    phrase, contact = re.subn(r"^contact with\s+", "", name, flags=re.I)
    phrase = re.sub(r"^(?:exposure to|strike of)\s+", "", phrase, flags=re.I)
    spoken = " ".join(_ACRONYMS.get(w.lower(), w.lower()) for w in phrase.split())
    return f"work near {spoken}" if contact else spoken


def _control_labels(library: HazardLibrary, hazard_code: str) -> str:
    hazard = library.hazard(hazard_code)
    labels: list[str] = []
    for code in hazard.typical_controls if hazard else []:
        c = library.control(code)
        if c is None or not c.type.satisfies_high_risk_rule or not c.keywords:
            continue
        label = "isolation" if c.type == ControlType.ISOLATION else c.keywords[0]
        if len(label.split()) > 2:  # keep the spoken question short and natural
            continue
        label = " ".join(_ACRONYMS.get(w, w) for w in label.split())
        if label not in labels:
            labels.append(label)
    joined = " or ".join(labels[:2]) or "isolation or engineering"
    return joined.removesuffix(" controls").removesuffix(" control")


def gap_question(kind: GapKind, path: str, library: HazardLibrary) -> str | None:
    parts = path.strip("/").split("/")
    if parts[0] == "hazards" and len(parts) >= 2 and (h := library.hazard(parts[1])):
        name = _spoken(h.name)
        if kind == GapKind.HIGH_RISK_WITHOUT_CONTROL:
            q = f"I heard {name}, but no {_control_labels(library, h.code)} control. What's the plan?"
        elif kind == GapKind.HAZARD_WITHOUT_CONTROL:
            q = f"I heard {name}. How are we controlling that?"
        elif kind == GapKind.UNCONFIRMED_HAZARD:
            q = f"This job often involves {name}. Is that a risk today?"
        elif kind == GapKind.CONTRADICTION:
            q = f"I heard mixed things about {name}. Can someone confirm?"
        else:
            return None
        return trim(q)
    if kind == GapKind.MISSING_REQUIRED_FIELD:
        return _FIELD_QUESTIONS.get(path)
    return None


def trim(text: str, max_words: int = MAX_WORDS) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]).rstrip(",.;") + "?"
