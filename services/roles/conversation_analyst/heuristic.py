"""Deterministic conversation analyst.

Per segment: drop filtered / non-crew / low-confidence / purely off-topic talk; split into clauses;
match library phrases with word boundaries (longest first); detect explicit negation and questions;
pull job details, emergency arrangements, permits and task steps with patterns; link replies to the
voice prompter's last question (``ANSWER`` observations) and resolve yes/no replies to crew questions.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

from packages.common.config import get_settings
from packages.schemas import (
    ConversationAnalystRequest,
    ConversationAnalystResponse,
    EvidenceRef,
    Gap,
    HazardLibrary,
    Observation,
    ObservationKind,
    SegmentSource,
    TranscriptSegment,
)

from ..common import RoleRun, evidence_for, library, merge_evidence
from ..text import Clause, PhraseMatcher, is_negated, is_off_topic, matcher, normalise, split_clauses, yes_no
from ..text import control_status as tense_of
from . import patterns

ROLE = "conversation_analyst"
ANSWER_WINDOW = 3  # crew segments after a voice prompt that may answer it
SHORT_REPLY_TOKENS = 8
_FILLER = re.compile(r"^(?:yeah|yep|yes|nah|no|righto|ok(?:ay)?|look|well|um+|ah+|so)\b[,\s]*", re.I)
_ANSWER_LEAD = re.compile(r"^(?:it's|it is|it'll be|that'll be|that's|we'll use|we'll be|use|at|by|the)\s+", re.I)


@dataclass
class _PromptContext:
    gap: Gap | None
    remaining: int = ANSWER_WINDOW


def _drop_reason(seg: TranscriptSegment, crew_ids: set[str], min_conf: float) -> str | None:
    if seg.filtered:
        return seg.filter_reason or "filtered"
    if crew_ids and seg.user_id and seg.user_id not in crew_ids:
        return "non_crew"
    if seg.confidence < min_conf:
        return "low_confidence"
    return None


class _SegmentExtractor:
    def __init__(self, lib: HazardLibrary, phrase_matcher: PhraseMatcher):
        self.lib = lib
        self.m = phrase_matcher

    def extract(self, seg: TranscriptSegment) -> tuple[list[Observation], bool]:
        """Observations from one segment, and whether any clause was off-topic chatter."""
        out: list[Observation] = []
        off_topic = False
        for clause in split_clauses(seg.text):
            if is_off_topic(clause.norm):
                off_topic = True
                continue
            ev = [evidence_for(seg, clause.text)]
            out.extend(self._library_observations(seg, clause, ev))
            out.extend(self._pattern_observations(seg, clause, ev))
        return _dedupe(out), off_topic

    def _library_observations(self, seg: TranscriptSegment, clause: Clause,
                              ev: list[EvidenceRef]) -> list[Observation]:
        out: list[Observation] = []
        matches = self.m.find(clause.norm)
        spans = [(x.start, x.end) for x in matches]
        control_spans = [(x.start, x.end) for x in matches if x.kind == "control"]
        ppe_spans = [(x.start, x.end) for x in matches if x.kind == "control"
                     and (c := self.lib.control(x.code)) is not None and c.type.value == "ppe"]
        question = clause.is_question
        speaker = seg.user_id or seg.speaker_id
        for x in matches:
            negated = is_negated(clause.norm, x.start, x.end, spans)
            base = 0.6 if " " not in x.keyword else 0.85
            conf = 0.4 if question else base
            attrs: dict[str, object] = {"keyword": x.keyword}
            if question:
                attrs["question"] = True
            if x.kind == "hazard":
                # "arc flash gear" names PPE; it is not a statement that the hazard is present.
                if _inside_longer(x, ppe_spans):
                    continue
                h = self.lib.hazard(x.code)
                out.append(Observation(kind=ObservationKind.HAZARD, text=h.name if h else x.keyword,
                                       code_hint=x.code, negated=negated, speaker_id=speaker, evidence=ev,
                                       confidence=conf, attributes=attrs))
            elif x.kind == "control":
                c = self.lib.control(x.code)
                if c is None:
                    continue
                kind = ObservationKind.PPE if c.type.value == "ppe" else ObservationKind.CONTROL
                attrs["status"] = tense_of(clause.norm)
                attrs["control_type"] = c.type.value
                out.append(Observation(kind=kind, text=c.name, code_hint=x.code, negated=negated,
                                       speaker_id=speaker, evidence=ev, confidence=conf, attributes=attrs))
            elif x.kind == "site_condition":
                # "wet methods", "isolate the solar": a control phrase is not a statement about the site.
                if _inside_longer(x, control_spans):
                    continue
                sc = next((s for s in self.lib.site_conditions if s.code == x.code), None)
                out.append(Observation(kind=ObservationKind.SITE_CONDITION, text=sc.name if sc else x.keyword,
                                       code_hint=x.code, negated=negated, speaker_id=speaker, evidence=ev,
                                       confidence=conf, attributes=attrs))
            elif x.kind == "task_type" and not negated and not question:
                t = self.lib.task_type(x.code)
                out.append(Observation(kind=ObservationKind.JOB_DETAIL, text=t.name if t else x.keyword,
                                       code_hint=x.code, speaker_id=speaker, evidence=ev, confidence=0.8,
                                       attributes={"field": "task_type", "value": x.code, "keyword": x.keyword}))
        return out

    def _pattern_observations(self, seg: TranscriptSegment, clause: Clause,
                              ev: list[EvidenceRef]) -> list[Observation]:
        out: list[Observation] = []
        speaker = seg.user_id or seg.speaker_id
        for item in [*patterns.job_details(clause.text), *patterns.emergency(clause.text, seg.speaker_name)]:
            kind = ObservationKind.JOB_DETAIL if item.kind == "job_detail" else ObservationKind.EMERGENCY
            out.append(Observation(kind=kind, text=f"{item.field.replace('_', ' ')}: {item.value}",
                                   speaker_id=speaker, evidence=ev, confidence=item.confidence,
                                   attributes={"field": item.field, "value": item.value}))
        for ptype, ref, phrase in patterns.permits(clause.text):
            start = clause.norm.find(normalise(phrase).split(" ")[0])
            if start >= 0 and is_negated(clause.norm, start, start + len(phrase)):
                continue
            if not ref and tense_of(clause.norm) != "in_place":
                continue  # "we'll need a permit" is a plan, not a permit on the job
            out.append(Observation(kind=ObservationKind.PERMIT, text=f"{ptype.replace('_', ' ')} {ref}".strip(),
                                   speaker_id=speaker, evidence=ev, confidence=0.85 if ref else 0.65,
                                   attributes={"permit_type": ptype, "reference": ref}))
        if not clause.is_question and (step := patterns.task_step(clause.text)):
            cue, description = step
            out.append(Observation(kind=ObservationKind.TASK, text=description, speaker_id=speaker, evidence=ev,
                                   confidence=0.75, attributes={"cue": cue}))
        return out


def _inside_longer(x, spans: list[tuple[int, int]]) -> bool:  # type: ignore[no-untyped-def]
    return any(s <= x.start and x.end <= e and (e - s) > (x.end - x.start) for s, e in spans)


def _dedupe(observations: list[Observation]) -> list[Observation]:
    """One observation per (kind, code/field/text, negated) per segment; merge evidence quotes."""
    seen: dict[tuple[object, ...], Observation] = {}
    for obs in observations:
        key = (obs.kind, obs.code_hint or obs.attributes.get("field") or obs.text.lower(), obs.negated,
               obs.attributes.get("value"))
        if key in seen:
            prev = seen[key]
            seen[key] = prev.model_copy(update={"evidence": merge_evidence(prev.evidence, obs.evidence),
                                                "confidence": max(prev.confidence, obs.confidence)})
        else:
            seen[key] = obs
    return list(seen.values())


def _match_gap(prompt_seg: TranscriptSegment, gaps: list[Gap]) -> Gap | None:
    text = normalise(prompt_seg.text)
    for gap in gaps:
        if gap.question and normalise(gap.question) == text:
            return gap
    asked = [g for g in gaps if g.asked_at is not None]
    return max(asked, key=lambda g: g.asked_at) if asked else None  # type: ignore[arg-type,return-value]


def _answer_observations(seg: TranscriptSegment, gap: Gap, own: list[Observation]) -> list[Observation]:
    """Link a crew reply to the gap the voice prompter just asked about."""
    ev = [evidence_for(seg)]
    speaker = seg.user_id or seg.speaker_id
    parts = gap.path.strip("/").split("/")
    controls = [o for o in own if o.kind in (ObservationKind.CONTROL, ObservationKind.PPE) and not o.negated]
    attrs: dict[str, object] = {"gap_id": gap.id, "path": gap.path,
                                "control_codes": [o.code_hint for o in controls if o.code_hint],
                                "status": controls[0].attributes.get("status") if controls else None}
    out: list[Observation] = []
    if parts[0] == "hazards" and len(parts) >= 2:
        attrs["hazard_code"] = parts[1]
        yn = yes_no(normalise(seg.text))
        if yn is not None:
            attrs["confirmed"] = yn
    elif parts[0] in ("emergency", "job") and len(parts) == 2:
        field = parts[1]
        if not any(o.attributes.get("field") == field for o in own):
            value = _ANSWER_LEAD.sub("", _FILLER.sub("", seg.text.strip())).strip(" .,!?")
            if value and yes_no(normalise(seg.text)) is not False:
                value = value[:1].upper() + value[1:]
                kind = ObservationKind.EMERGENCY if parts[0] == "emergency" else ObservationKind.JOB_DETAIL
                out.append(Observation(kind=kind, text=f"{field.replace('_', ' ')}: {value}", speaker_id=speaker,
                                       evidence=ev, confidence=0.7,
                                       attributes={"field": field, "value": value, "gap_id": gap.id}))
    out.append(Observation(kind=ObservationKind.ANSWER, text=seg.text.strip()[:200], speaker_id=speaker,
                           evidence=ev, confidence=0.7, attributes=attrs))
    return out


def _resolve_reply(seg: TranscriptSegment, pending: list[Observation]) -> list[Observation]:
    """A short "yeah" / "nah, none" after a crew question confirms or negates what was asked about."""
    norm = normalise(seg.text)
    if not pending or len(norm.split()) > SHORT_REPLY_TOKENS:
        return []
    answer = yes_no(norm)
    if answer is None:
        return []
    ev = evidence_for(seg)
    out = []
    for q in pending:
        attrs = {k: v for k, v in q.attributes.items() if k != "question"} | {"confirmed_by_reply": True}
        out.append(q.model_copy(update={"negated": not answer, "confidence": 0.75, "attributes": attrs,
                                        "evidence": merge_evidence(q.evidence, [ev]),
                                        "speaker_id": seg.user_id or seg.speaker_id}, deep=True))
    return out


def _is_recent(obs: Observation, recent_keys: set[tuple[object, ...]]) -> bool:
    return _key(obs) in recent_keys


def _key(obs: Observation) -> tuple[object, ...]:
    return (obs.kind, obs.code_hint, obs.negated, obs.attributes.get("field"), obs.attributes.get("value"),
            tuple(sorted(e.segment_id for e in obs.evidence)))


def extract_window(req: ConversationAnalystRequest, lib: HazardLibrary) -> tuple[list[Observation], list[str]]:
    """Core of the heuristic analyst; also used by the LLM analyst as a recall safety net."""
    settings = get_settings()
    extractor = _SegmentExtractor(lib, matcher(lib))
    crew_ids = {c.user_id for c in req.crew}
    open_gaps = [g for g in req.open_gaps if g.status == "open"]
    observations: list[Observation] = []
    dropped: list[str] = []
    prompt_ctx: _PromptContext | None = None
    pending: list[Observation] = []
    pending_speaker: str | None = None

    for seg in sorted(req.window, key=lambda s: (s.seq, s.start_ms)):
        if seg.source == SegmentSource.VOICE_PROMPT:
            prompt_ctx = _PromptContext(_match_gap(seg, open_gaps))
            pending = []
            continue
        if _drop_reason(seg, crew_ids, settings.stt_min_confidence):
            dropped.append(seg.id)
            continue
        own, off_topic = extractor.extract(seg)
        seg_obs = list(own)
        speaker = seg.user_id or seg.speaker_id
        if prompt_ctx and prompt_ctx.gap and prompt_ctx.remaining > 0:
            seg_obs.extend(_answer_observations(seg, prompt_ctx.gap, own))
            prompt_ctx.remaining -= 1
        elif pending and speaker != pending_speaker and not own:
            seg_obs.extend(_resolve_reply(seg, pending))
        # Off-topic chatter, or an unlinked voice (customer, passer-by) saying nothing about the job.
        if not seg_obs and (off_topic or (crew_ids and not seg.user_id)):
            dropped.append(seg.id)
            continue
        questions = [o for o in own if o.attributes.get("question")]
        if questions:
            pending, pending_speaker = questions, speaker
        elif seg_obs:
            pending = []
        observations.extend(seg_obs)

    recent = {_key(o) for o in req.recent_observations}
    return [o for o in observations if not _is_recent(o, recent)], dropped


def task_type_hint(observations: list[Observation], fallback: str | None) -> str | None:
    votes = Counter(o.code_hint for o in observations
                    if o.kind == ObservationKind.JOB_DETAIL and o.attributes.get("field") == "task_type"
                    and o.code_hint)
    return votes.most_common(1)[0][0] if votes else fallback


async def analyse(req: ConversationAnalystRequest) -> ConversationAnalystResponse:
    run = RoleRun(ROLE)
    lib = library()
    observations, dropped = extract_window(req, lib)
    return ConversationAnalystResponse(observations=observations, dropped_segment_ids=dropped,
                                       task_type_hint=task_type_hint(observations, req.task_type), meta=run.meta())
