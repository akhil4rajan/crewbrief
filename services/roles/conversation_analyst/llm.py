"""LLM conversation analyst (Azure OpenAI, EXTRACTOR_DEPLOYMENT).

The model only proposes observations; this module grounds them: evidence is rebuilt from the real
segments it cites (observations citing nothing real are discarded), codes are checked against the
library, and the deterministic phrase matcher's hazard detections are merged back in as a recall
safety net — a missed critical hazard costs far more than a duplicate.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from packages.common.config import get_settings
from packages.schemas import (
    ConversationAnalystRequest,
    ConversationAnalystResponse,
    Observation,
    ObservationKind,
    SegmentSource,
)

from ..common import PROVIDER_AZURE_OPENAI, RoleRun, evidence_for, library, prompt
from ..llm import complete_json, library_catalogue
from .heuristic import ROLE, _drop_reason, extract_window, task_type_hint


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Tense(StrEnum):
    PLANNED = "planned"
    IN_PLACE = "in_place"


class DropReason(StrEnum):
    OFF_TOPIC = "off_topic"
    NON_CREW = "non_crew"


class LlmObservation(_Strict):
    kind: ObservationKind
    text: str
    code_hint: str | None
    negated: bool
    segment_ids: list[str]
    confidence: float = Field(ge=0, le=1)
    field: str | None  # job_detail / emergency field name
    value: str | None  # extracted value, or permit reference
    permit_type: str | None
    tense: Tense | None
    gap_id: str | None


class LlmDropped(_Strict):
    segment_id: str
    reason: DropReason


class AnalystOutput(_Strict):
    observations: list[LlmObservation]
    dropped: list[LlmDropped]
    task_type_hint: str | None


def _valid_code(code: str | None, kind: ObservationKind) -> str | None:
    if not code:
        return None
    lib = library()
    if kind == ObservationKind.HAZARD:
        return code if lib.hazard(code) else None
    if kind in (ObservationKind.CONTROL, ObservationKind.PPE):
        return code if lib.control(code) else None
    if kind == ObservationKind.SITE_CONDITION:
        return code if any(s.code == code for s in lib.site_conditions) else None
    if kind == ObservationKind.JOB_DETAIL:
        return code if lib.task_type(code) else None
    return None


async def analyse(req: ConversationAnalystRequest) -> ConversationAnalystResponse:
    settings = get_settings()
    run = RoleRun(ROLE, provider=PROVIDER_AZURE_OPENAI, model=settings.extractor_deployment)
    lib = library()
    crew_ids = {c.user_id for c in req.crew}
    pre_dropped = [s.id for s in req.window if s.source != SegmentSource.VOICE_PROMPT
                   and _drop_reason(s, crew_ids, settings.stt_min_confidence)]
    segments = {s.id: s for s in req.window if s.id not in pre_dropped}
    payload = {
        "window": [{"id": s.id, "speaker": s.speaker_name or s.speaker_id, "user_id": s.user_id, "text": s.text,
                    "start_ms": s.start_ms, "source": s.source.value} for s in segments.values()],
        "crew": [{"user_id": c.user_id, "name": c.name, "role": c.role} for c in req.crew],
        "open_gaps": [{"id": g.id, "path": g.path, "question": g.question} for g in req.open_gaps
                      if g.status == "open"],
        "known_task_type": req.task_type,
        "library": library_catalogue(),
    }
    result = await complete_json(deployment=settings.extractor_deployment, prompt=prompt(ROLE), payload=payload,
                                 output_model=AnalystOutput, settings=settings)
    run.model = result.model
    run.add_usage(result.tokens_in, result.tokens_out)

    observations: list[Observation] = []
    for item in result.output.observations:
        cited = [segments[sid] for sid in item.segment_ids
                 if sid in segments and segments[sid].source != SegmentSource.VOICE_PROMPT]
        if not cited:
            continue  # no grounding in the transcript -> not an observation
        attrs: dict[str, object] = {}
        if item.field:
            attrs["field"] = item.field
        if item.value:
            attrs["value"] = item.value
        if item.kind == ObservationKind.PERMIT:
            attrs.update(permit_type=item.permit_type or "permit_to_work", reference=(item.value or "").upper())
        if item.tense:
            attrs["status"] = item.tense.value
        if item.gap_id:
            attrs["gap_id"] = item.gap_id
            gap = next((g for g in req.open_gaps if g.id == item.gap_id), None)
            if gap and gap.path.startswith("/hazards/"):
                attrs["hazard_code"] = gap.path.split("/")[2]
        code = _valid_code(item.code_hint, item.kind)
        if item.kind == ObservationKind.JOB_DETAIL and item.field == "task_type":
            code = _valid_code(item.value or item.code_hint, item.kind)
            if not code:
                continue
            attrs["value"] = code
        if item.kind in (ObservationKind.CONTROL, ObservationKind.PPE) and code:
            attrs["control_type"] = lib.control(code).type.value  # type: ignore[union-attr]
        observations.append(Observation(
            kind=item.kind, text=item.text[:300], code_hint=code, negated=item.negated,
            speaker_id=cited[0].user_id or cited[0].speaker_id, evidence=[evidence_for(s) for s in cited],
            confidence=item.confidence, attributes=attrs))

    # Recall safety net: keep every hazard the phrase matcher heard that the model did not report.
    heuristic_obs, _ = extract_window(req, lib)
    covered = {(o.code_hint, o.negated) for o in observations if o.kind == ObservationKind.HAZARD}
    for obs in heuristic_obs:
        if obs.kind == ObservationKind.HAZARD and obs.code_hint and (obs.code_hint, obs.negated) not in covered \
                and not obs.negated:
            observations.append(obs.model_copy(update={"attributes": {**obs.attributes, "safety_net": True}}))

    llm_dropped = [d.segment_id for d in result.output.dropped if d.segment_id in segments]
    hint = _valid_code(result.output.task_type_hint, ObservationKind.JOB_DETAIL)
    return ConversationAnalystResponse(
        observations=observations, dropped_segment_ids=list(dict.fromkeys(pre_dropped + llm_dropped)),
        task_type_hint=hint or task_type_hint(observations, req.task_type), meta=run.meta())
