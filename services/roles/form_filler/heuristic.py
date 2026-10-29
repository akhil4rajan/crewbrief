"""Deterministic patch assembly (used in both modes).

Invariants (also enforced by ``packages.rules.validate_patch``; we avoid producing rejects):
never remove, never touch a human-sourced node, never mark not-present without evidence, every
AI value cites evidence except unconfirmed typical hazards and proposed controls, and idempotent:
running twice with the same inputs yields no patches the second time.
"""

from __future__ import annotations

import re
from typing import Any

from packages.schemas import (
    ControlStatus,
    FormFillerRequest,
    FormFillerResponse,
    FormPatch,
    HazardAssessment,
    HazardStatus,
    Observation,
    ObservationKind,
    PatchOp,
    Provenance,
    Source,
)

from ..common import RoleRun, library, merge_evidence

ROLE = "form_filler"
JOB_FIELDS = {"title", "work_order_id", "task_type", "location", "description", "scheduled_start"}
EMERGENCY_FIELDS = {"muster_point", "nearest_hospital", "first_aider", "communications"}
_CONTROL_RANK = {ControlStatus.PROPOSED: 0, ControlStatus.PLANNED: 1, ControlStatus.IN_PLACE: 2}
_SIMILAR_TASK = 0.6


def _is_human(node: Any) -> bool:
    prov = getattr(node, "provenance", None)
    return prov is not None and prov.source == Source.HUMAN


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "item"


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


class _Builder:
    def __init__(self, req: FormFillerRequest, run: RoleRun):
        self.form = req.draft
        self.run = run
        self.patches: list[FormPatch] = []
        self.new_tasks: list[str] = []

    def prov(self, evidence: list, confidence: float) -> Provenance:
        return self.run.provenance(evidence, confidence)

    def emit(self, op: PatchOp, path: str, value: Any, prov: Provenance) -> None:
        self.patches.append(FormPatch(op=op, path=path, value=value, provenance=prov))

    # --- scalar fields --------------------------------------------------------------------
    def field(self, section: str, name: str, value: Any, obs: Observation) -> None:
        current = getattr(getattr(self.form, section), name)
        if current is not None and (_is_human(current) or current.value == value):
            return
        if current is not None and current.value not in (None, "") and current.provenance.confidence > obs.confidence:
            return  # keep the better-supported value; the verifier flags contradictions
        if not obs.evidence:
            return
        prov = self.prov(obs.evidence, obs.confidence)
        op = PatchOp.REPLACE if current is not None else PatchOp.ADD
        self.emit(op, f"/{section}/{name}", {"value": value, "provenance": prov.model_dump(mode="json")}, prov)

    # --- hazards ---------------------------------------------------------------------------
    def hazard(self, a: HazardAssessment) -> None:
        lib = library()
        existing = self.form.hazards.get(a.hazard_code)
        if existing is not None and _is_human(existing):
            return
        if existing is None:
            ok = (a.status == HazardStatus.PRESENT and a.evidence) \
                or (a.status == HazardStatus.UNCONFIRMED and (a.evidence or a.origin.value != "mentioned")) \
                or (a.status == HazardStatus.NOT_PRESENT and a.evidence)
            if not ok:
                return
            prov = self.prov(a.evidence, a.confidence)
            controls = {r.control_code: self._control_entry(r) for r in a.controls
                        if a.status != HazardStatus.NOT_PRESENT and (r.status == ControlStatus.PROPOSED or r.evidence)}
            h = lib.hazard(a.hazard_code)
            entry = {"code": a.hazard_code, "name": a.name, "category": a.category, "severity": a.severity.value,
                     "status": a.status.value, "origin": a.origin.value, "description": h.description if h else "",
                     "controls": controls, "provenance": prov.model_dump(mode="json")}
            self.emit(PatchOp.ADD, f"/hazards/{a.hazard_code}", entry, prov)
            return

        # Status upgrade with new evidence: unconfirmed/not_present -> present, unconfirmed -> not_present.
        upgrade = a.evidence and (
            (a.status == HazardStatus.PRESENT and existing.status != HazardStatus.PRESENT)
            or (a.status == HazardStatus.NOT_PRESENT and existing.status == HazardStatus.UNCONFIRMED))
        if upgrade:
            evidence = merge_evidence(existing.provenance.evidence, a.evidence)
            prov = self.prov(evidence, max(a.confidence, existing.provenance.confidence))
            entry = existing.model_dump(mode="json")
            entry.update(status=a.status.value, provenance=prov.model_dump(mode="json"))
            if a.status == HazardStatus.NOT_PRESENT:
                entry["controls"] = {k: v for k, v in entry["controls"].items()
                                     if v["status"] != ControlStatus.PROPOSED.value
                                     or v["provenance"]["source"] == Source.HUMAN.value}
            self.emit(PatchOp.REPLACE, f"/hazards/{a.hazard_code}", entry, prov)
            new_status = a.status
        else:
            new_status = existing.status
        if new_status == HazardStatus.NOT_PRESENT:
            return
        for r in a.controls:
            cur = existing.controls.get(r.control_code)
            path = f"/hazards/{a.hazard_code}/controls/{r.control_code}"
            if cur is None:
                if r.status == ControlStatus.PROPOSED or r.evidence:
                    entry = self._control_entry(r)
                    self.emit(PatchOp.ADD, path, entry, Provenance.model_validate(entry["provenance"]))
            elif not _is_human(cur) and r.evidence and _CONTROL_RANK[r.status] > _CONTROL_RANK[cur.status]:
                entry = self._control_entry(r, merge_evidence(cur.provenance.evidence, r.evidence))
                self.emit(PatchOp.REPLACE, path, entry, Provenance.model_validate(entry["provenance"]))

    def _control_entry(self, r, evidence: list | None = None) -> dict[str, Any]:  # type: ignore[no-untyped-def]
        c = library().control(r.control_code)
        prov = self.prov(evidence if evidence is not None else r.evidence, r.confidence)
        return {"code": r.control_code, "name": r.name, "type": r.type.value, "status": r.status.value,
                "description": c.description if c else "", "provenance": prov.model_dump(mode="json")}

    # --- collections -----------------------------------------------------------------------
    def task(self, obs: Observation) -> None:
        words = _words(obs.text)
        known = [t.description for t in self.form.tasks.values()] + self.new_tasks
        for desc in known:
            other = _words(desc)
            if words and len(words & other) / len(words | other) >= _SIMILAR_TASK:
                return
        n = len(self.form.tasks) + len(self.new_tasks) + 1
        while f"T{n}" in self.form.tasks:
            n += 1
        self.new_tasks.append(obs.text)
        prov = self.prov(obs.evidence, obs.confidence)
        self.emit(PatchOp.ADD, f"/tasks/T{n}", {"id": f"T{n}", "order": n, "description": obs.text,
                                               "provenance": prov.model_dump(mode="json")}, prov)

    def keyed(self, section: str, key: str, value: dict[str, Any], obs: Observation) -> None:
        if key in getattr(self.form, section) or any(p.path == f"/{section}/{key}" for p in self.patches):
            return
        prov = self.prov(obs.evidence, obs.confidence)
        self.emit(PatchOp.ADD, f"/{section}/{key}", {**value, "provenance": prov.model_dump(mode="json")}, prov)


def build_patches(req: FormFillerRequest, run: RoleRun) -> list[FormPatch]:
    lib = library()
    b = _Builder(req, run)
    best: dict[tuple[str, str], Observation] = {}
    for obs in req.observations:
        if obs.negated or not obs.evidence:
            continue
        field = obs.attributes.get("field")
        if obs.kind == ObservationKind.JOB_DETAIL and field in JOB_FIELDS:
            section = "job"
        elif obs.kind == ObservationKind.EMERGENCY and field in EMERGENCY_FIELDS:
            section = "emergency"
        else:
            continue
        key = (section, str(field))
        if key not in best or obs.confidence > best[key].confidence:
            best[key] = obs
    # A known task type also gives the job a title when nobody said one.
    if ("job", "task_type") in best and ("job", "title") not in best and req.draft.job.title is None:
        tt = best[("job", "task_type")]
        if t := lib.task_type(str(tt.attributes.get("value") or tt.code_hint)):
            best[("job", "title")] = tt.model_copy(update={"attributes": {"field": "title", "value": t.name},
                                                           "confidence": 0.6})
    for (section, field), obs in best.items():
        b.field(section, field, obs.attributes.get("value") or obs.code_hint, obs)

    for a in req.assessments:
        b.hazard(a)

    for obs in req.observations:
        if obs.negated or not obs.evidence or obs.attributes.get("question"):
            continue
        if obs.kind == ObservationKind.TASK:
            b.task(obs)
        elif obs.kind == ObservationKind.SITE_CONDITION:
            key = obs.code_hint or _slug(obs.text)
            b.keyed("site_conditions", key, {"id": key, "code": obs.code_hint, "description": obs.text}, obs)
        elif obs.kind == ObservationKind.PPE and obs.code_hint and lib.control(obs.code_hint):
            b.keyed("ppe", obs.code_hint, {"code": obs.code_hint, "name": lib.control(obs.code_hint).name}, obs)
        elif obs.kind == ObservationKind.PERMIT:
            ptype = str(obs.attributes.get("permit_type") or "permit_to_work")
            ref = str(obs.attributes.get("reference") or "")
            if any(p.type == ptype and p.reference == ref for p in req.draft.permits.values()):
                continue
            key = _slug(f"{ptype}-{ref}" if ref else ptype)
            b.keyed("permits", key, {"id": key, "type": ptype, "reference": ref}, obs)
    return b.patches


async def fill(req: FormFillerRequest) -> FormFillerResponse:
    run = RoleRun(ROLE)
    return FormFillerResponse(patches=build_patches(req, run), meta=run.meta())
