"""LLM form filler: deterministic patches plus an LLM-written job description when none exists."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from packages.common.config import get_settings
from packages.schemas import FormFillerRequest, FormFillerResponse, FormPatch, ObservationKind, PatchOp

from ..common import PROVIDER_AZURE_OPENAI, RoleRun, prompt
from ..llm import complete_json
from .heuristic import ROLE, build_patches


class JobDescriptionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str | None
    segment_ids: list[str]
    confidence: float = Field(ge=0, le=1)


async def fill(req: FormFillerRequest) -> FormFillerResponse:
    settings = get_settings()
    run = RoleRun(ROLE, provider=PROVIDER_AZURE_OPENAI, model=settings.extractor_deployment)
    patches = build_patches(req, run)
    kinds = (ObservationKind.TASK, ObservationKind.JOB_DETAIL)
    evidence = {e.segment_id: e for o in req.observations if o.kind in kinds for e in o.evidence}
    if req.draft.job.description is None and evidence and not any(p.path == "/job/description" for p in patches):
        facts = [{"kind": o.kind.value, "text": o.text, **({"value": o.attributes["value"]} if "value" in o.attributes
                                                          else {})}
                 for o in req.observations if o.kind in (ObservationKind.TASK, ObservationKind.JOB_DETAIL)]
        result = await complete_json(
            deployment=settings.extractor_deployment, prompt=prompt(ROLE), output_model=JobDescriptionOutput,
            payload={"segments": [{"id": e.segment_id, "speaker": e.speaker_id, "text": e.quote}
                                  for e in evidence.values()], "facts": facts}, settings=settings)
        run.add_usage(result.tokens_in, result.tokens_out)
        cited = [evidence[s] for s in result.output.segment_ids if s in evidence]
        if result.output.description and cited:
            prov = run.provenance(cited, result.output.confidence)
            patches.append(FormPatch(op=PatchOp.ADD, path="/job/description", provenance=prov,
                                     value={"value": result.output.description[:400],
                                            "provenance": prov.model_dump(mode="json")}))
    return FormFillerResponse(patches=patches, meta=run.meta())
