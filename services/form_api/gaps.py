"""Gap list maintenance: upsert by stable id, keep human dismissals, resolve what disappeared."""

from __future__ import annotations

from collections.abc import Callable

from packages.rules import evaluate_draft
from packages.schemas import Form, Gap, GapKind, GapStatus, HazardLibrary, utcnow

# Gap kinds the code rules (``evaluate_draft``) can detect. Only these may be resolved by a local
# rule re-check; contradictions and low-confidence findings need the verifier.
RULE_GAP_KINDS = frozenset({
    GapKind.MISSING_REQUIRED_FIELD,
    GapKind.HIGH_RISK_WITHOUT_CONTROL,
    GapKind.HAZARD_WITHOUT_CONTROL,
    GapKind.UNCONFIRMED_HAZARD,
    GapKind.UNSUPPORTED_FIELD,
})

NO_LONGER_DETECTED = "no longer detected"


def gaps_from_rules(form: Form, library: HazardLibrary) -> list[Gap]:
    gaps: dict[str, Gap] = {}
    for v in evaluate_draft(form, library):
        if v.gap_kind is None:
            continue
        gap_id = Gap.stable_id(v.gap_kind, v.path)
        gaps.setdefault(gap_id, Gap(id=gap_id, kind=v.gap_kind, severity=v.severity, path=v.path, message=v.message))
    return list(gaps.values())


def merge_gaps(existing: list[Gap], incoming: list[Gap],
               may_resolve: Callable[[Gap], bool] = lambda _: True) -> list[Gap]:
    """Return the full updated gap list.

    * incoming gaps replace stored ones by id, keeping ``created_at`` and any question/asked time;
    * a gap a person dismissed stays dismissed even if it is reported again;
    * open gaps that are no longer reported (and ``may_resolve``) are marked resolved.
    """
    now = utcnow()
    by_id = {g.id: g for g in existing}
    reported: set[str] = set()
    for gap in incoming:
        reported.add(gap.id)
        old = by_id.get(gap.id)
        if old is None:
            by_id[gap.id] = gap
            continue
        if old.status == GapStatus.DISMISSED:
            continue
        update = {"created_at": old.created_at, "question": gap.question or old.question,
                  "asked_at": gap.asked_at or old.asked_at}
        if gap.status == GapStatus.OPEN:
            update |= {"resolved_at": None, "resolution": None}
        elif gap.status == GapStatus.RESOLVED and gap.resolved_at is None:
            update["resolved_at"] = old.resolved_at or now
        by_id[gap.id] = gap.model_copy(update=update)
    for gap_id, old in list(by_id.items()):
        if gap_id not in reported and old.status == GapStatus.OPEN and may_resolve(old):
            by_id[gap_id] = old.model_copy(update={"status": GapStatus.RESOLVED, "resolved_at": now,
                                                   "resolution": NO_LONGER_DETECTED})
    return list(by_id.values())
