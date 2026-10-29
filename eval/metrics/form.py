"""Form filler field accuracy and whole-form evidence metrics.

* Field match: exact (after normalisation) or semantic (content-token overlap F1 >= threshold)
  against any of the SME's accepted answers, for the job and emergency fields in the gold form.
* Evidence coverage: share of AI-filled fields that cite a span of this briefing's transcript.
* Hallucination rate: share of AI-filled fields with no evidence, or whose evidence does not hold up
  (unknown segment, or a quote that cannot be found in the transcript the pipeline received).

Library suggestions the rules allow without evidence (unconfirmed task-typical hazards and
``proposed`` controls) are not claims about the briefing, so they are excluded from both.
"""

from __future__ import annotations

from typing import Any

from packages.schemas import ControlStatus, FieldValue, Form, HazardStatus, Provenance, Source

from ..dataset import Briefing
from ..pipeline import BriefingRun
from .base import Ratio
from .text import normalise, quote_in_text, token_overlap


def _accepted(gold: str | list[str]) -> list[str]:
    return [gold] if isinstance(gold, str) else list(gold)


def field_metrics(briefing: Briefing, run: BriefingRun, semantic_threshold: float
                  ) -> tuple[dict[str, Ratio], list[dict[str, Any]]]:
    m: dict[str, Ratio] = {}
    rows: list[dict[str, Any]] = []
    for section, gold_fields in (("job", briefing.gold.job), ("emergency", briefing.gold.emergency)):
        values = getattr(run.form, section)
        for name, gold in gold_fields.items():
            fv: FieldValue | None = getattr(values, name, None)
            predicted = "" if fv is None or fv.value in (None, "") else str(fv.value)
            accepted = _accepted(gold)
            exact = bool(predicted) and any(normalise(predicted) == normalise(a) for a in accepted)
            overlap = max((token_overlap(a, predicted) for a in accepted), default=0.0) if predicted else 0.0
            semantic = exact or overlap >= semantic_threshold
            m[f"form_fields.{section}.{name}"] = Ratio(int(semantic), 1)
            m["form.field_exact"] = m.get("form.field_exact", Ratio()) + Ratio(int(exact), 1)
            m["form.field_semantic"] = m.get("form.field_semantic", Ratio()) + Ratio(int(semantic), 1)
            m["form.field_filled"] = m.get("form.field_filled", Ratio()) + Ratio(int(bool(predicted)), 1)
            if not exact:
                rows.append({"field": f"/{section}/{name}", "predicted": predicted or None,
                             "expected": accepted, "overlap": round(overlap, 2), "semantic_match": semantic})
    return m, rows


def ai_claims(form: Form) -> list[tuple[str, Provenance]]:
    """Every AI-filled value on the form that asserts something about the briefing."""
    claims: list[tuple[str, Provenance]] = []
    for section in ("job", "emergency"):
        for name, fv in getattr(form, section):
            if isinstance(fv, FieldValue) and fv.value not in (None, ""):
                claims.append((f"/{section}/{name}", fv.provenance))
    if form.notes is not None and form.notes.value not in (None, ""):
        claims.append(("/notes", form.notes.provenance))
    claims += [(f"/tasks/{k}", v.provenance) for k, v in form.tasks.items()]
    claims += [(f"/site_conditions/{k}", v.provenance) for k, v in form.site_conditions.items()]
    claims += [(f"/ppe/{k}", v.provenance) for k, v in form.ppe.items()]
    claims += [(f"/permits/{k}", v.provenance) for k, v in form.permits.items()]
    for code, hazard in form.hazards.items():
        if hazard.status != HazardStatus.UNCONFIRMED:
            claims.append((f"/hazards/{code}", hazard.provenance))
        claims += [(f"/hazards/{code}/controls/{c}", ctl.provenance)
                   for c, ctl in hazard.controls.items() if ctl.status != ControlStatus.PROPOSED]
    return [(path, prov) for path, prov in claims if prov.source == Source.AI]


def evidence_metrics(briefing: Briefing, run: BriefingRun) -> tuple[dict[str, Ratio], list[dict[str, Any]]]:
    segments = {s.id: s for s in run.segments}
    full_text = " ".join(s.text for s in run.segments)
    noise_ids = {run.segment_id_for_line(ln.id) for ln in briefing.transcript.lines if ln.noise}
    claims = ai_claims(run.form)
    covered = hallucinated = noise_only = 0
    problems: list[dict[str, Any]] = []
    for path, prov in claims:
        cited = [e for e in prov.evidence if e.segment_id in segments]
        valid = [e for e in cited if not e.quote or quote_in_text(e.quote, segments[e.segment_id].text)
                 or quote_in_text(e.quote, full_text)]
        covered += bool(cited)
        if not valid:
            hallucinated += 1
            reason = "no evidence" if not prov.evidence else (
                "unknown segment" if not cited else "quote not found in transcript")
            problems.append({"path": path, "reason": reason,
                             "quotes": [e.quote for e in prov.evidence][:2]})
        elif all(e.segment_id in noise_ids for e in valid):
            noise_only += 1
            problems.append({"path": path, "reason": "evidence is only off-topic chatter",
                             "quotes": [e.quote for e in valid][:2]})
    n = len(claims)
    return {
        "form.evidence_coverage": Ratio(covered, n),
        "form.hallucination_rate": Ratio(hallucinated, n),
        "form.noise_evidence_rate": Ratio(noise_only, n),
    }, problems
