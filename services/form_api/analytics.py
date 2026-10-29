"""AI-draft vs signed-form comparison: the per-session diff and the edit-rate accuracy metric.

Forms are flattened to *entities* (a job/emergency field, a task, a hazard without its controls,
a control, a PPE item...). Two entities are equal when their content matches, ignoring provenance,
so a supervisor confirming a value unchanged is not counted as an edit.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from packages.schemas import AuditAction, AuditEntry, Form, Source

from .models import DiffChange, EditRateResponse, FieldEditRate, RoleEditRate

COLLECTIONS = ("crew", "tasks", "site_conditions", "ppe", "permits")
SCALAR_SECTIONS = ("job", "emergency")


def _escape(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def flatten(form: Form) -> dict[str, dict[str, Any]]:
    """JSON-pointer path → entity JSON (provenance included)."""
    doc = form.model_dump(mode="json")
    out: dict[str, dict[str, Any]] = {}
    for section in SCALAR_SECTIONS:
        for name, field in (doc.get(section) or {}).items():
            if isinstance(field, dict):
                out[f"/{section}/{name}"] = field
    if isinstance(doc.get("notes"), dict):
        out["/notes"] = doc["notes"]
    for section in COLLECTIONS:
        for key, entity in doc[section].items():
            out[f"/{section}/{_escape(key)}"] = entity
    for code, hazard in doc["hazards"].items():
        controls = hazard.pop("controls", {})
        out[f"/hazards/{_escape(code)}"] = hazard
        for ccode, control in controls.items():
            out[f"/hazards/{_escape(code)}/controls/{_escape(ccode)}"] = control
    return out


def entity_path(path: str) -> str:
    """The entity a (possibly deeper) patch path belongs to, e.g. ``/hazards/X/status`` → ``/hazards/X``."""
    parts = path.split("/")[1:]
    if not parts or not parts[0]:
        return path
    if parts[0] == "notes":
        return "/notes"
    if parts[0] == "hazards" and len(parts) >= 4 and parts[2] == "controls":
        return "/" + "/".join(parts[:4])
    return "/" + "/".join(parts[:2])


def path_pattern(path: str) -> str:
    parts = path.split("/")[1:]
    root = parts[0]
    if root == "job":
        return path
    if root == "notes":
        return "/notes"
    if root == "hazards":
        return "/hazards/*/controls/*" if len(parts) >= 4 else "/hazards/*"
    return f"/{root}/*"


def _content(entity: dict[str, Any] | None) -> dict[str, Any] | None:
    return None if entity is None else {k: v for k, v in entity.items() if k != "provenance"}


def _prov(entity: dict[str, Any] | None) -> dict[str, Any]:
    return (entity or {}).get("provenance") or {}


def human_edit_roles(audit: list[AuditEntry]) -> dict[str, str]:
    """Entity path → role of the last person who edited it (from the audit log)."""
    roles: dict[str, str] = {}
    for entry in audit:
        if entry.action == AuditAction.HUMAN_EDIT and entry.path:
            role = entry.details.get("role")
            if role:
                roles[entity_path(entry.path)] = str(role)
    return roles


def diff_forms(before: Form, after: Form, editor_roles: dict[str, str] | None = None) -> list[DiffChange]:
    editor_roles = editor_roles or {}
    b, a = flatten(before), flatten(after)
    changes: list[DiffChange] = []
    for path in sorted(b.keys() | a.keys()):
        old, new = _content(b.get(path)), _content(a.get(path))
        if old == new:
            continue
        op = "add" if old is None else "remove" if new is None else "replace"
        role = editor_roles.get(path) or _prov(a.get(path)).get("role") or _prov(b.get(path)).get("role")
        changes.append(DiffChange(path=path, op=op, before=old, after=new, role=role))
    return changes


def _rate(edited: int, filled: int) -> float:
    return round(edited / filled, 4) if filled else 0.0


def edit_rate(pairs: list[tuple[Form, Form]]) -> EditRateResponse:
    """``pairs`` = (AI draft snapshotted at REVIEW, signed form) per session."""
    fields: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0])  # ai_filled, edited, added_by_human
    roles: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for ai_form, final_form in pairs:
        ai, final = flatten(ai_form), flatten(final_form)
        for path, entity in ai.items():
            prov = _prov(entity)
            if prov.get("source") != Source.AI.value:
                continue
            edited = _content(final.get(path)) != _content(entity)
            pattern, role = path_pattern(path), prov.get("role") or "unknown"
            fields[pattern][0] += 1
            fields[pattern][1] += edited
            roles[role][0] += 1
            roles[role][1] += edited
        for path in final.keys() - ai.keys():
            if _prov(final[path]).get("source") == Source.HUMAN.value:
                fields[path_pattern(path)][2] += 1
    return EditRateResponse(
        sessions=len(pairs),
        fields=[FieldEditRate(path_pattern=p, ai_filled=f, edited=e, edit_rate=_rate(e, f), added_by_human=h)
                for p, (f, e, h) in sorted(fields.items())],
        roles=[RoleEditRate(role=r, ai_filled=f, edited=e, edit_rate=_rate(e, f))
               for r, (f, e) in sorted(roles.items())],
    )
