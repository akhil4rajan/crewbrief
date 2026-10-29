"""Rules-based verifier: ``packages.rules.evaluate_draft`` violations become stable, merged gaps."""

from __future__ import annotations

from packages.rules import evaluate_draft
from packages.schemas import (
    Gap,
    GapKind,
    GapSeverity,
    GapStatus,
    HazardStatus,
    Source,
    VerifierRequest,
    VerifierResponse,
    utcnow,
)

from ..common import RoleRun, library
from ..questions import gap_question

ROLE = "verifier"
AUTO_RESOLUTION = "verifier: no longer detected"
LOW_CONFIDENCE = 0.5
_RULE_KINDS = {"required_field": GapKind.MISSING_REQUIRED_FIELD, "crew_required": GapKind.MISSING_REQUIRED_FIELD,
               "no_hazards": GapKind.MISSING_REQUIRED_FIELD, "evidence_required": GapKind.UNSUPPORTED_FIELD,
               "hazard_unconfirmed": GapKind.UNCONFIRMED_HAZARD,
               "high_risk_requires_isolation_or_engineering": GapKind.HIGH_RISK_WITHOUT_CONTROL,
               "hazard_requires_control": GapKind.HAZARD_WITHOUT_CONTROL}


def rule_gaps(req: VerifierRequest) -> list[Gap]:
    lib = library()
    gaps: list[Gap] = []
    for v in evaluate_draft(req.draft, lib):
        kind = v.gap_kind or _RULE_KINDS.get(v.rule, GapKind.MISSING_REQUIRED_FIELD)
        gaps.append(Gap(id=Gap.stable_id(kind, v.path), kind=kind, severity=v.severity, path=v.path,
                        message=v.message, question=gap_question(kind, v.path, lib)))
    for code, h in req.draft.hazards.items():
        if h.provenance.source == Source.AI and h.status == HazardStatus.PRESENT \
                and h.provenance.has_evidence and h.provenance.confidence < LOW_CONFIDENCE:
            path = f"/hazards/{code}"
            gaps.append(Gap(id=Gap.stable_id(GapKind.LOW_CONFIDENCE, path), kind=GapKind.LOW_CONFIDENCE,
                            severity=GapSeverity.INFO, path=path,
                            message=f"{h.name} was inferred with low confidence ({h.provenance.confidence:.2f})"))
    return gaps


def merge_gaps(current: list[Gap], existing: list[Gap]) -> list[Gap]:
    """Upsert by stable id: keep created/asked times, keep human dismissals, auto-resolve vanished gaps."""
    now = utcnow()
    prior = {g.id: g for g in existing}
    out: dict[str, Gap] = {}
    for gap in current:
        if gap.id in out:
            continue
        old = prior.get(gap.id)
        if old is None:
            out[gap.id] = gap
        elif old.status == GapStatus.DISMISSED or (
                old.status == GapStatus.RESOLVED and old.resolution and old.resolution != AUTO_RESOLUTION):
            out[gap.id] = old  # a person closed it; the AI does not reopen it
        else:
            out[gap.id] = gap.model_copy(update={"created_at": old.created_at, "asked_at": old.asked_at,
                                                 "question": gap.question or old.question,
                                                 "status": GapStatus.OPEN, "resolved_at": None, "resolution": None})
    for old in existing:
        if old.id not in out:
            out[old.id] = old if old.status != GapStatus.OPEN else old.model_copy(
                update={"status": GapStatus.RESOLVED, "resolved_at": now, "resolution": AUTO_RESOLUTION})
    return list(out.values())


async def verify(req: VerifierRequest) -> VerifierResponse:
    run = RoleRun(ROLE)
    return VerifierResponse(gaps=merge_gaps(rule_gaps(req), req.existing_gaps), meta=run.meta())
