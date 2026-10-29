"""LLM hazard expert: the model only maps un-coded observations to retrieved library candidates.

Everything else (task-typical hazards, control linking, proposals) is the deterministic builder, so
codes stay constrained to the library and the output is auditable.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from packages.common.config import get_settings
from packages.schemas import HazardExpertRequest, HazardExpertResponse, ObservationKind

from ..common import PROVIDER_AZURE_OPENAI, RoleRun, library, prompt
from ..llm import complete_json
from .heuristic import CONTROL_KINDS, ROLE, build_assessments, resolve_codes


class Mapping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    observation_id: str
    code: str | None
    confidence: float = Field(ge=0, le=1)


class HazardMappingOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mappings: list[Mapping]


async def assess(req: HazardExpertRequest) -> HazardExpertResponse:
    from knowledge.search import get_search

    settings = get_settings()
    run = RoleRun(ROLE, provider=PROVIDER_AZURE_OPENAI, model=settings.extractor_deployment)
    lib = library()
    codes = {o.id: o.code_hint for o in req.observations if o.code_hint
             and ((o.kind == ObservationKind.HAZARD and lib.hazard(o.code_hint))
                  or (o.kind in CONTROL_KINDS and lib.control(o.code_hint)))}
    items, allowed = [], {}
    for obs in req.observations:
        if obs.id in codes or obs.kind not in (ObservationKind.HAZARD, *CONTROL_KINDS):
            continue
        kinds = {"hazard"} if obs.kind == ObservationKind.HAZARD else {"control"}
        hits = await get_search().search(obs.text, kinds=kinds, top=5)
        allowed[obs.id] = {h.code for h in hits}
        items.append({"observation_id": obs.id, "kind": obs.kind.value, "text": obs.text, "negated": obs.negated,
                      "candidates": [{"code": h.code, "title": h.title, "text": h.text[:200]} for h in hits]})
    if items:
        result = await complete_json(deployment=settings.extractor_deployment, prompt=prompt(ROLE),
                                     payload={"items": items}, output_model=HazardMappingOutput, settings=settings)
        run.model = result.model
        run.add_usage(result.tokens_in, result.tokens_out)
        for m in result.output.mappings:
            if m.code and m.code in allowed.get(m.observation_id, set()):
                codes[m.observation_id] = m.code
    else:
        codes = await resolve_codes(req.observations, lib)
    assessments, task_type = build_assessments(req, codes, lib)
    return HazardExpertResponse(assessments=assessments, task_type=task_type, meta=run.meta())
