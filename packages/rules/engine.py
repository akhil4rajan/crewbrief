from __future__ import annotations

import copy
from typing import Any

import jsonpatch
from pydantic import ValidationError

from packages.schemas import (
    FieldValue,
    Form,
    FormPatch,
    GapKind,
    GapSeverity,
    HazardLibrary,
    HazardOrigin,
    HazardStatus,
    Model,
    PatchOp,
    Session,
    SessionState,
    Source,
    User,
    UserRole,
)

# Top-level form sections a patch may touch.
WRITABLE_ROOTS = {"job", "crew", "tasks", "site_conditions", "hazards", "ppe", "emergency", "permits", "notes"}
CUSTOM_MARKER = "-CUSTOM-"
REQUIRED_FIELDS = ["/job/title", "/job/location", "/emergency/muster_point"]


class RuleViolation(Model):
    rule: str
    severity: GapSeverity
    path: str
    message: str
    gap_kind: GapKind | None = None


# ---------------------------------------------------------------------------
# Patch application
# ---------------------------------------------------------------------------


def _split(path: str) -> list[str]:
    if not path.startswith("/"):
        raise ValueError(f"JSON pointer must start with '/': {path}")
    return [p.replace("~1", "/").replace("~0", "~") for p in path.split("/")[1:]]


def _get(doc: Any, parts: list[str]) -> Any:
    node = doc
    for part in parts:
        if isinstance(node, dict):
            node = node.get(part)
        else:
            return None
        if node is None:
            return None
    return node


def _stamp_provenance(value: Any, patch: FormPatch) -> Any:
    """Copy the patch provenance onto the node when the node carries none."""
    if isinstance(value, dict) and "provenance" not in value and _looks_like_entity(value):
        value = {**value, "provenance": patch.provenance.model_dump(mode="json")}
    return value


def _looks_like_entity(value: dict[str, Any]) -> bool:
    return "value" in value or "code" in value or "description" in value or "type" in value


def apply_patch(form: Form, patch: FormPatch) -> Form:
    """Apply one patch and re-validate the whole form. Raises ``ValueError`` on failure."""
    doc = form.model_dump(mode="json")
    parts = _split(patch.path)
    value = _stamp_provenance(copy.deepcopy(patch.value), patch)
    op = patch.op.value
    # JSON Patch "add" on an existing key replaces; "replace" on a missing optional key fails,
    # so normalise: replace-on-missing becomes add when the parent exists.
    if op == PatchOp.REPLACE and _get(doc, parts) is None:
        op = "add"
    if op == "add" and _get(doc, parts[:-1]) is None and len(parts) > 1:
        raise ValueError(f"Parent of {patch.path} does not exist")
    ops = [{"op": op, "path": patch.path}] if op == "remove" else [{"op": op, "path": patch.path, "value": value}]
    try:
        doc = jsonpatch.apply_patch(doc, ops)
        return Form.model_validate(doc)
    except (jsonpatch.JsonPatchException, jsonpatch.JsonPointerException) as exc:
        raise ValueError(f"Cannot apply {op} {patch.path}: {exc}") from exc
    except ValidationError as exc:
        raise ValueError(f"Schema validation failed for {patch.path}: {exc.errors()[:3]}") from exc


def apply_patches(form: Form, patches: list[FormPatch], library: HazardLibrary
                  ) -> tuple[Form, list[FormPatch], list[tuple[FormPatch, RuleViolation]]]:
    """Validate + apply in order. Returns (new form, applied, rejected-with-reason)."""
    applied: list[FormPatch] = []
    rejected: list[tuple[FormPatch, RuleViolation]] = []
    for patch in patches:
        violations = [v for v in validate_patch(form, patch, library) if v.severity == GapSeverity.BLOCKING]
        if violations:
            rejected.append((patch, violations[0]))
            continue
        try:
            form = apply_patch(form, patch)
            applied.append(patch)
        except ValueError as exc:
            rejected.append((patch, RuleViolation(rule="schema_validation", severity=GapSeverity.BLOCKING,
                                                  path=patch.path, message=str(exc))))
    return form, applied, rejected


# ---------------------------------------------------------------------------
# Patch validation
# ---------------------------------------------------------------------------


def _block(rule: str, path: str, message: str) -> RuleViolation:
    return RuleViolation(rule=rule, severity=GapSeverity.BLOCKING, path=path, message=message)


def _is_human(patch: FormPatch) -> bool:
    return patch.provenance.source == Source.HUMAN


def _existing_source(doc: dict[str, Any], parts: list[str]) -> str | None:
    node = _get(doc, parts)
    if isinstance(node, dict):
        prov = node.get("provenance")
        if isinstance(prov, dict):
            return prov.get("source")
    return None


def validate_patch(form: Form, patch: FormPatch, library: HazardLibrary) -> list[RuleViolation]:
    try:
        parts = _split(patch.path)
    except ValueError as exc:
        return [_block("invalid_path", patch.path, str(exc))]
    if not parts or parts[0] not in WRITABLE_ROOTS:
        return [_block("invalid_path", patch.path, f"Path root must be one of {sorted(WRITABLE_ROOTS)}")]

    out: list[RuleViolation] = []
    doc = form.model_dump(mode="json")
    human = _is_human(patch)

    # AI never overwrites or removes what a human set (at this node or any ancestor entity).
    if not human:
        for depth in range(len(parts), 0, -1):
            if _existing_source(doc, parts[:depth]) == Source.HUMAN.value:
                out.append(_block("human_value_protected", patch.path,
                                  "Value was set by a person; the AI may not change it"))
                break
        if patch.op == PatchOp.REMOVE:
            out.append(_block("ai_remove_forbidden", patch.path, "The AI may not remove form content"))

    # Code mapping.
    if parts[0] == "hazards" and len(parts) >= 2:
        code = parts[1]
        if library.hazard(code) is None and not (human and CUSTOM_MARKER in code):
            out.append(_block("unknown_hazard_code", patch.path, f"Hazard code {code} is not in the library"))
        if len(parts) >= 4 and parts[2] == "controls":
            ccode = parts[3]
            if library.control(ccode) is None and not (human and CUSTOM_MARKER in ccode):
                out.append(_block("unknown_control_code", patch.path,
                                  f"Control code {ccode} is not in the library"))
    if parts[0] == "ppe" and len(parts) >= 2 and library.control(parts[1]) is None \
            and not (human and CUSTOM_MARKER in parts[1]):
        out.append(_block("unknown_control_code", patch.path, f"PPE code {parts[1]} is not in the library"))

    if patch.op == PatchOp.REMOVE:
        return out

    value = patch.value
    # Never mark a hazard "not present" without explicit evidence (or a human decision).
    status = None
    if parts[0] == "hazards" and len(parts) == 2 and isinstance(value, dict):
        status = value.get("status")
    elif parts[0] == "hazards" and len(parts) == 3 and parts[2] == "status":
        status = value
    if status == HazardStatus.NOT_PRESENT.value and not human and not patch.provenance.has_evidence:
        out.append(_block("not_present_requires_evidence", patch.path,
                          "A hazard can only be marked not present with explicit evidence"))

    # AI values must cite evidence, except hazards suggested as typical for the task/site.
    if not human and not patch.provenance.has_evidence:
        typical = (parts[0] == "hazards" and len(parts) == 2 and isinstance(value, dict)
                   and value.get("origin") in (HazardOrigin.TASK_TYPICAL.value, HazardOrigin.SITE_CONDITION.value)
                   and value.get("status") == HazardStatus.UNCONFIRMED.value)
        proposed_control = (parts[0] == "hazards" and len(parts) == 4 and isinstance(value, dict)
                            and value.get("status") == "proposed")
        if not (typical or proposed_control):
            out.append(_block("evidence_required", patch.path, "AI-filled values must cite transcript evidence"))
    return out


# ---------------------------------------------------------------------------
# Whole-draft evaluation (used by the verifier and at sign-off)
# ---------------------------------------------------------------------------


def _field_missing(doc: dict[str, Any], pointer: str) -> bool:
    node = _get(doc, _split(pointer))
    return node is None or (isinstance(node, dict) and node.get("value") in (None, ""))


def evaluate_draft(form: Form, library: HazardLibrary) -> list[RuleViolation]:
    out: list[RuleViolation] = []
    doc = form.model_dump(mode="json")

    for pointer in REQUIRED_FIELDS:
        if _field_missing(doc, pointer):
            out.append(RuleViolation(rule="required_field", severity=GapSeverity.WARNING, path=pointer,
                                     message=f"{pointer.strip('/').replace('/', ' ').replace('_', ' ')} is empty",
                                     gap_kind=GapKind.MISSING_REQUIRED_FIELD))
    if not form.crew:
        out.append(RuleViolation(rule="crew_required", severity=GapSeverity.BLOCKING, path="/crew",
                                 message="No crew members are recorded on the form",
                                 gap_kind=GapKind.MISSING_REQUIRED_FIELD))
    if not any(h.status == HazardStatus.PRESENT for h in form.hazards.values()):
        out.append(RuleViolation(rule="no_hazards", severity=GapSeverity.WARNING, path="/hazards",
                                 message="No hazards have been confirmed as present",
                                 gap_kind=GapKind.MISSING_REQUIRED_FIELD))

    for code, hazard in form.hazards.items():
        path = f"/hazards/{code}"
        if hazard.status == HazardStatus.PRESENT:
            active = [c for c in hazard.controls.values() if c.status != "proposed"]
            definition = library.hazard(code)
            critical = set(definition.critical_controls) if definition else set()
            if hazard.severity.is_high_risk and critical and not critical & {c.code for c in active}:
                names = ", ".join(c.name for cc in sorted(critical) if (c := library.control(cc)))
                out.append(RuleViolation(
                    rule="high_risk_requires_critical_control", severity=GapSeverity.BLOCKING, path=path,
                    message=f"{hazard.name} is {hazard.severity.value} risk and needs one of: {names}",
                    gap_kind=GapKind.HIGH_RISK_WITHOUT_CONTROL))
            elif hazard.severity.is_high_risk and not any(c.type.satisfies_high_risk_rule for c in active):
                out.append(RuleViolation(
                    rule="high_risk_requires_isolation_or_engineering", severity=GapSeverity.BLOCKING, path=path,
                    message=f"{hazard.name} is {hazard.severity.value} risk but has no confirmed isolation or "
                            f"engineering control", gap_kind=GapKind.HIGH_RISK_WITHOUT_CONTROL))
            elif not active:
                out.append(RuleViolation(rule="hazard_requires_control", severity=GapSeverity.WARNING, path=path,
                                         message=f"{hazard.name} has no confirmed control",
                                         gap_kind=GapKind.HAZARD_WITHOUT_CONTROL))
        elif hazard.status == HazardStatus.UNCONFIRMED:
            sev = GapSeverity.BLOCKING if hazard.severity.is_high_risk else GapSeverity.WARNING
            out.append(RuleViolation(rule="hazard_unconfirmed", severity=sev, path=path,
                                     message=f"{hazard.name} is typical for this job but was not discussed",
                                     gap_kind=GapKind.UNCONFIRMED_HAZARD))
        if hazard.provenance.source == Source.AI and not hazard.provenance.has_evidence \
                and hazard.status == HazardStatus.PRESENT:
            out.append(RuleViolation(rule="evidence_required", severity=GapSeverity.WARNING, path=path,
                                     message=f"{hazard.name} has no supporting transcript evidence",
                                     gap_kind=GapKind.UNSUPPORTED_FIELD))

    for section in ("job", "emergency"):
        for name, fv in (doc.get(section) or {}).items():
            if isinstance(fv, dict) and fv.get("value") not in (None, ""):
                prov = FieldValue.model_validate(fv).provenance
                if prov.source == Source.AI and not prov.has_evidence:
                    out.append(RuleViolation(rule="evidence_required", severity=GapSeverity.WARNING,
                                             path=f"/{section}/{name}",
                                             message=f"{section} {name} has no supporting evidence",
                                             gap_kind=GapKind.UNSUPPORTED_FIELD))
    return out


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


def can_sign_off(user: User, session: Session) -> tuple[bool, str]:
    if session.state != SessionState.REVIEW:
        return False, f"Session must be in REVIEW to sign off (is {session.state})"
    if user.has_role(UserRole.SAFETY_ADMIN):
        return True, "safety_admin"
    if not user.has_role(UserRole.SUPERVISOR):
        return False, "Only a supervisor can sign off"
    if session.supervisor_id and session.supervisor_id != user.id:
        return False, "Only the session's assigned supervisor can sign off"
    if user.id in session.crew_member_ids:
        return False, "A crew member on the job cannot sign off their own form"
    return True, "supervisor"
