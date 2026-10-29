"""LLM verifier (VERIFIER_DEPLOYMENT): rules gaps plus model-found contradictions / unsupported claims."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from packages.common.config import get_settings
from packages.schemas import Gap, GapKind, GapSeverity, VerifierRequest, VerifierResponse

from ..common import PROVIDER_AZURE_OPENAI, RoleRun, prompt
from ..llm import complete_json
from ..questions import trim
from .heuristic import ROLE, merge_gaps, rule_gaps

MAX_TRANSCRIPT_SEGMENTS = 200


class FindingKind(StrEnum):
    CONTRADICTION = "contradiction"
    UNSUPPORTED_FIELD = "unsupported_field"
    LOW_CONFIDENCE = "low_confidence"


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: FindingKind
    severity: GapSeverity
    path: str
    message: str
    question: str | None
    segment_ids: list[str]


class VerifierOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    findings: list[Finding]


def _path_exists(form: dict, path: str) -> bool:
    node = form
    for part in path.strip("/").split("/"):
        if not isinstance(node, dict) or part not in node:
            return False
        node = node[part]
    return node is not None


async def verify(req: VerifierRequest) -> VerifierResponse:
    settings = get_settings()
    run = RoleRun(ROLE, provider=PROVIDER_AZURE_OPENAI, model=settings.verifier_deployment)
    gaps = rule_gaps(req)
    form = req.draft.model_dump(mode="json", exclude={"crew"})
    transcript = [s for s in req.transcript if not s.filtered][-MAX_TRANSCRIPT_SEGMENTS:]
    result = await complete_json(
        deployment=settings.verifier_deployment, prompt=prompt(ROLE), output_model=VerifierOutput, settings=settings,
        payload={"form": form, "transcript": [{"id": s.id, "speaker": s.speaker_name or s.speaker_id,
                                               "text": s.text} for s in transcript]})
    run.model = result.model
    run.add_usage(result.tokens_in, result.tokens_out)
    known_segments = {s.id for s in transcript}
    rule_ids = {g.id for g in gaps}
    for f in result.output.findings:
        if not _path_exists(form, f.path) or not set(f.segment_ids) & known_segments:
            continue  # ungrounded findings are dropped, like ungrounded fields
        kind = GapKind(f.kind.value)
        gid = Gap.stable_id(kind, f.path)
        if gid not in rule_ids:
            rule_ids.add(gid)
            gaps.append(Gap(id=gid, kind=kind, severity=f.severity, path=f.path, message=f.message[:500],
                            question=trim(f.question) if f.question else None))
    return VerifierResponse(gaps=merge_gaps(gaps, req.existing_gaps), meta=run.meta())
