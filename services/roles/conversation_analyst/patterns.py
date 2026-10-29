"""Regex extractors for the briefing facts that are not library phrases.

Work orders, addresses, muster points, hospitals, first aiders, radio channels, permits and task
steps. Values are taken from the original wording (capitalisation preserved) of one clause.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_I = re.IGNORECASE
_END = r"(?=\s*(?:[,.;!?]|\s(?:and|so|but|if)\s|$))"

_WORK_ORDER = re.compile(
    r"\b(?:work\s*order|w\.?o\.?|job\s*(?:number|no\.?)|wo)\s*(?:number|no\.?|#|is|:|\s)*"
    r"([A-Z]{0,4}[-\s]?\d[\d\-\s]{2,}\d)\b", _I)
_STREET_TYPES = (r"Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Place|Pl|Lane|Ln|Crescent|Cres|Parade|Pde|"
                 r"Highway|Hwy|Way|Close|Cl|Terrace|Tce|Boulevard|Blvd|Circuit|Cct|Grove|Gr|Esplanade")
_ADDRESS = re.compile(rf"\b(\d{{1,5}}[A-Za-z]?\s+(?:[A-Za-z']+\s+){{1,3}}(?:{_STREET_TYPES}))\b\.?", _I)
_SUBURB = re.compile(r"^,?\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b")
_NOT_SUBURB = {"Today", "Mate", "And", "So", "But", "Then", "This", "Righto", "We", "It", "The"}
_CORNER = re.compile(rf"\bcorner of\s+((?:[A-Za-z']+\s+){{1,3}}(?:{_STREET_TYPES})\s+and\s+"
                     rf"(?:[A-Za-z']+\s+){{1,3}}(?:{_STREET_TYPES}))\b", _I)
_POLE_ID = re.compile(r"\bpole\s+(?:number\s+|no\.?\s*|id\s+)?([A-Z]{0,3}\d{4,})\b", _I)
_TITLE = re.compile(
    r"\b(?:today's job is|the job today is|job today is|today's job's|job today's|today we're doing|"
    r"we're here to|we're here for|this morning we're doing|this arvo we're doing)\s+(?:a|an|the|to)?\s*"
    rf"(.{{4,80}}?){_END}", _I)

_MUSTER = re.compile(
    r"\b(?:muster(?:ing)?|assembly|emergency meeting)\s*(?:point|area|spot)?\s*(?:is|will be|'s|:|today is)?\s*"
    rf"(?:at|by|near|on|in|next to|over at|out at)?\s*(.{{3,60}}?){_END}", _I)
_HOSPITAL = re.compile(
    r"\b(?:nearest|closest)\s+(?:hospital|emergency department|emergency|e\.?d\.?|medical centre)\s*"
    rf"(?:is|'s|:|would be|will be)?\s*(?:at|in|the)?\s*(.{{3,60}}?){_END}", _I)
_NAMED_HOSPITAL = re.compile(r"\b((?:[A-Z][A-Za-z']+\s){1,3}(?:Hospital|Base Hospital|Medical Centre))\b")
_FIRST_AIDER = [
    re.compile(r"\b([A-Z][a-z]+)(?:'s|\s+is|\s+will be)\s+(?:our|the)\s+first\s*aid(?:er| officer)\b"),
    re.compile(r"\bfirst\s*aid(?:er| officer)\s*(?:today\s+)?(?:is|'s|will be)\s+([A-Z][a-z]+)\b", _I),
]
_SELF_FIRST_AIDER = re.compile(r"\bI(?:'m| am)\s+(?:the\s+|our\s+)?first\s*aid(?:er| officer)\b", _I)
_RADIO = re.compile(r"\b(?:(uhf|radio)\s*(?:channel|ch)?\s*|channel\s+)(\d{1,3})\b", _I)
_MOBILE = re.compile(r"\b(?:good|full|decent)\s+(?:mobile\s+)?(?:coverage|reception|signal)\b"
                     r"|\b(?:coverage|reception|signal)\s+(?:is|'s)\s+(?:good|fine|ok|okay)\b", _I)

_PERMIT = re.compile(
    r"\b(access permit|access authority|switching (?:instruction|program(?:me)?|sheet)|vegetation permit|"
    r"confined space (?:entry )?permit|hot work permit|road occupancy (?:licence|license|permit)|"
    r"permit to work|excavation permit)\b(?:\s*(?:number|no\.?|#|is|:)\s*)*([A-Z]{0,4}[-\s]?\d[\d-]{2,})?", _I)
_PERMIT_TYPES = {"access permit": "access_permit", "access authority": "access_permit",
                 "switching": "switching_instruction", "vegetation permit": "vegetation_permit",
                 "confined space": "confined_space_permit", "hot work permit": "hot_work_permit",
                 "road occupancy": "road_occupancy", "permit to work": "permit_to_work",
                 "excavation permit": "excavation_permit"}

_STEP_CUE = re.compile(
    r"^(?:and\s+|so\s+|righto,?\s+|ok(?:ay)?,?\s+)?(first(?:ly)?(?: up| off)?|to start(?: with)?|step one|"
    r"we'll start by|the plan is to|then|and then|after that|next|once that's done|once that is done|"
    r"once (?:it's|that's|we've) [a-z' ]+?(?:done|dead|isolated|tested)|finally|lastly|last of all)\b[,\s]*", _I)
_SUBJECT = re.compile(r"^(?:we'll|we will|i'll|i will|we're going to|we are going to|we're gonna|we gonna|"
                      r"we need to|we have to|we've got to|you'll|we)\s+", _I)


@dataclass(frozen=True)
class Extracted:
    kind: str  # job_detail | emergency | permit | task
    field: str  # field name, permit type, or "step"
    value: str
    confidence: float


def _clean(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip(" ,.;:-")
    return value[:1].upper() + value[1:] if value else value


def job_details(text: str) -> list[Extracted]:
    out: list[Extracted] = []
    if m := _WORK_ORDER.search(text):
        out.append(Extracted("job_detail", "work_order_id", re.sub(r"\s+", "", m.group(1)).upper(), 0.9))
    if m := _ADDRESS.search(text):
        address = _clean(m.group(1))
        if (sub := _SUBURB.match(text[m.end():])) and sub.group(1).split()[0] not in _NOT_SUBURB:
            address = f"{address}, {sub.group(1)}"
        out.append(Extracted("job_detail", "location", address, 0.85))
    elif m := _CORNER.search(text):
        out.append(Extracted("job_detail", "location", f"Corner of {_clean(m.group(1))}", 0.8))
    elif m := _POLE_ID.search(text):
        out.append(Extracted("job_detail", "location", f"Pole {m.group(1).upper()}", 0.7))
    if m := _TITLE.search(text):
        title = _ADDRESS.split(m.group(1))[0]
        title = re.split(r"\s+(?:at|on|in)\s*$|\s+(?:at|on)\s+(?=\d)", title)[0]
        if len(title.split()) >= 2:
            out.append(Extracted("job_detail", "title", _clean(title), 0.75))
    return out


def emergency(text: str, speaker_name: str | None) -> list[Extracted]:
    out: list[Extracted] = []
    if m := _MUSTER.search(text):
        out.append(Extracted("emergency", "muster_point", _clean(m.group(1)), 0.85))
    if m := _HOSPITAL.search(text):
        out.append(Extracted("emergency", "nearest_hospital", _clean(m.group(1)), 0.85))
    elif (m := _NAMED_HOSPITAL.search(text)) and re.search(r"\b(?:nearest|closest|hospital is)\b", text, _I):
        out.append(Extracted("emergency", "nearest_hospital", _clean(m.group(1)), 0.75))
    for pat in _FIRST_AIDER:
        if m := pat.search(text):
            out.append(Extracted("emergency", "first_aider", m.group(1).capitalize(), 0.85))
            break
    else:
        if speaker_name and _SELF_FIRST_AIDER.search(text):
            out.append(Extracted("emergency", "first_aider", speaker_name, 0.85))
    if m := _RADIO.search(text):
        band = "UHF" if (m.group(1) or "").lower() == "uhf" else "Radio"
        out.append(Extracted("emergency", "communications", f"{band} channel {m.group(2)}", 0.85))
    elif _MOBILE.search(text):
        out.append(Extracted("emergency", "communications", "Mobile phone (coverage confirmed)", 0.7))
    return out


def permits(text: str) -> list[tuple[str, str, str]]:
    """``(permit_type, reference, phrase)`` for each permit mentioned."""
    out = []
    for m in _PERMIT.finditer(text):
        phrase = m.group(1).lower()
        ptype = next(v for k, v in _PERMIT_TYPES.items() if phrase.startswith(k))
        ref = re.sub(r"\s+", "", m.group(2) or "").upper()
        out.append((ptype, ref, m.group(0)))
    return out


def task_step(text: str) -> tuple[str, str] | None:
    """``(cue, step description)`` when the clause describes a step ("first we'll isolate...")."""
    m = _STEP_CUE.match(text.strip())
    if not m:
        return None
    rest = _SUBJECT.sub("", text.strip()[m.end():]).strip(" ,.")
    if len(rest.split()) < 3:
        return None
    return m.group(1).lower(), _clean(rest)[:160]
