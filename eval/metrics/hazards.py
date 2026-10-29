"""Conversation analyst and hazard expert metrics.

Hazards are scored on the drafted form because a hazard only gets a library code once the analyst's
observation has been mapped by the hazard expert; ``analyst.mention_recall*`` isolates the analyst
by checking that it raised *some* hazard observation on the transcript lines where the SME saw the
hazard, regardless of the code. Recall is weighted by ``Severity.weight`` because missing a critical
hazard costs far more than missing a low one.
"""

from __future__ import annotations

from typing import Any

from packages.schemas import HazardLibrary, HazardStatus, ObservationKind, Severity

from ..dataset import Briefing
from ..pipeline import BriefingRun
from .base import Ratio


def _gold_severity(code: str, explicit: Severity | None, library: HazardLibrary, warnings: list[str]) -> Severity:
    if explicit is not None:
        return explicit
    hazard = library.hazard(code)
    if hazard is None:
        warnings.append(f"gold hazard {code} is not in the library; scored as high severity")
        return Severity.HIGH
    return hazard.severity


def hazard_metrics(briefing: Briefing, run: BriefingRun, library: HazardLibrary
                   ) -> tuple[dict[str, Ratio], dict[str, Any]]:
    gold = briefing.gold
    warnings: list[str] = []
    gold_present = {h.code: h for h in gold.hazards_present}
    severity = {h.code: _gold_severity(h.code, h.severity, library, warnings) for h in gold.hazards_present}
    acceptable = set(gold.hazards_acceptable)

    form_hazards = run.form.hazards
    predicted = {code: h for code, h in form_hazards.items() if h.status == HazardStatus.PRESENT}
    surfaced = {code for code, h in form_hazards.items() if h.status in (HazardStatus.PRESENT, HazardStatus.UNCONFIRMED)}

    found = [c for c in gold_present if c in predicted]
    missed = [c for c in gold_present if c not in predicted]
    false_pos = [c for c in predicted if c not in gold_present and c not in acceptable]
    scored_pred = [c for c in predicted if c not in acceptable or c in gold_present]
    critical = [c for c in gold_present if severity[c] == Severity.CRITICAL]

    m: dict[str, Ratio] = {
        "analyst.recall": Ratio(len(found), len(gold_present)),
        "analyst.precision": Ratio(len([c for c in scored_pred if c in gold_present]), len(scored_pred)),
        "analyst.recall_weighted": Ratio(sum(severity[c].weight for c in found),
                                         sum(severity[c].weight for c in gold_present)),
        "analyst.precision_weighted": Ratio(
            sum(predicted[c].severity.weight for c in scored_pred if c in gold_present),
            sum(predicted[c].severity.weight for c in scored_pred)),
        "analyst.critical_recall": Ratio(len([c for c in critical if c in predicted]), len(critical)),
        "analyst.surfaced_recall": Ratio(len([c for c in gold_present if c in surfaced]), len(gold_present)),
    }

    # Analyst in isolation: a non-negated hazard observation cited one of the SME's evidence lines.
    cited: set[str] = set()
    for obs in run.observations:
        if obs.kind == ObservationKind.HAZARD and not obs.negated:
            cited.update(e.segment_id for e in obs.evidence)
    spanned = [h for h in gold.hazards_present if h.evidence_lines]
    mentioned = [h for h in spanned if any(run.segment_id_for_line(ln) in cited for ln in h.evidence_lines)]
    m["analyst.mention_recall"] = Ratio(len(mentioned), len(spanned))
    m["analyst.mention_recall_weighted"] = Ratio(sum(severity[h.code].weight for h in mentioned),
                                                 sum(severity[h.code].weight for h in spanned))

    # Hazards the crew explicitly ruled out must never end up "present".
    ruled_out = gold.hazards_not_present
    contradicted = [h.code for h in ruled_out if h.code in predicted]
    m["analyst.not_present_respected"] = Ratio(len(ruled_out) - len(contradicted), len(ruled_out))
    m["analyst.not_present_recorded"] = Ratio(
        len([h for h in ruled_out if (e := form_hazards.get(h.code)) and e.status == HazardStatus.NOT_PRESENT]),
        len(ruled_out))

    # Hazard expert: required controls retrieved (any status, including library proposals) per found hazard.
    missing_controls: list[dict[str, str]] = []
    controls_hit = controls_total = fully = considered = 0
    for code, gh in gold_present.items():
        if code not in form_hazards or not gh.required_controls:
            continue
        considered += 1
        retrieved = set(form_hazards[code].controls)
        if code in run.assessments:
            retrieved |= {c.control_code for c in run.assessments[code].controls}
        hits = [c for c in gh.required_controls if c in retrieved]
        controls_hit += len(hits)
        controls_total += len(gh.required_controls)
        fully += len(hits) == len(gh.required_controls)
        missing_controls += [{"hazard": code, "control": c} for c in gh.required_controls if c not in retrieved]
    m["expert.control_recall"] = Ratio(controls_hit, controls_total)
    m["expert.hazards_fully_controlled"] = Ratio(fully, considered)

    # Hazard expert: code mapping. A predicted hazard citing a line where the SME identified hazards
    # should carry one of those hazards' codes.
    line_codes: dict[str, set[str]] = {}
    for gh in gold.hazards_present:
        for ln in gh.evidence_lines:
            line_codes.setdefault(run.segment_id_for_line(ln), set()).add(gh.code)
    mapping_errors: list[dict[str, Any]] = []
    mapped = correct = 0
    for code, entry in form_hazards.items():
        if entry.status != HazardStatus.PRESENT:
            continue
        expected: set[str] = set()
        for ev in entry.provenance.evidence:
            expected |= line_codes.get(ev.segment_id, set())
        if not expected:
            continue
        mapped += 1
        if code in expected or code in acceptable:
            correct += 1
        else:
            mapping_errors.append({"predicted": code, "expected_any_of": sorted(expected),
                                   "evidence": [e.quote for e in entry.provenance.evidence][:2]})
    m["expert.code_mapping"] = Ratio(correct, mapped)

    details = {
        "missed_hazards": [{"code": c, "severity": severity[c].value} for c in missed],
        "false_positive_hazards": [{"code": c, "severity": predicted[c].severity.value} for c in false_pos],
        "surfaced_unconfirmed": sorted(c for c in surfaced - set(predicted) if c in gold_present),
        "ruled_out_but_present": contradicted,
        "analyst_missed_spans": [h.code for h in spanned if h not in mentioned],
        "missing_controls": missing_controls,
        "code_mapping_errors": mapping_errors,
        "warnings": warnings,
    }
    return m, details
