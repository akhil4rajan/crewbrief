"""The extraction step: conversation analyst → hazard expert → form filler → rules.

Pure with respect to storage: it needs a roles client and the current form, not the form
API, so the eval harness runs exactly the same step offline over gold briefings.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from packages.rules import RuleViolation, apply_patches
from packages.schemas import (
    ConversationAnalystRequest,
    ConversationAnalystResponse,
    CrewEntry,
    Form,
    FormFillerRequest,
    FormFillerResponse,
    FormPatch,
    Gap,
    HazardExpertRequest,
    HazardExpertResponse,
    HazardLibrary,
    Model,
    Observation,
    RoleMeta,
    RoleName,
    TranscriptSegment,
    get_library,
)

from .clients import RolesClient

log = logging.getLogger(__name__)

class RoleInvocationError(RuntimeError):
    """A role call failed. ``metas`` holds the roles that completed before it (for the audit log)."""

    def __init__(self, role: RoleName, cause: Exception, latency_ms: int):
        super().__init__(f"{role.value} failed: {type(cause).__name__}: {cause}")
        self.role = role
        self.cause = cause
        self.latency_ms = latency_ms
        self.metas: list[RoleMeta] = []


async def invoke_role[R: Model](roles: RolesClient, role: RoleName, request: Model, response_type: type[R]) -> R:
    """Call one role; the response's ``meta.latency_ms`` is filled from wall clock if the role left it 0."""
    started = time.perf_counter()
    try:
        response: Any = await roles.invoke(role, request)
        if not isinstance(response, response_type):
            response = response_type.model_validate(response)
    except Exception as exc:  # noqa: BLE001 - wrapped so callers can audit and retry
        raise RoleInvocationError(role, exc, int((time.perf_counter() - started) * 1000)) from exc
    meta: RoleMeta = response.meta  # type: ignore[attr-defined]
    if not meta.latency_ms:
        elapsed = int((time.perf_counter() - started) * 1000)
        response = response.model_copy(update={"meta": meta.model_copy(update={"latency_ms": elapsed})})
    return response


@dataclass
class Extraction:
    """Result of one extraction step.

    Unpacks as ``patches, observations, metas``. ``patches`` are only those that passed the
    code-level safety rules against ``form``; ``rejected`` keeps the rest with the rule that
    stopped them. ``form`` is the draft with ``patches`` applied (what the form API will hold
    if nothing changed concurrently).
    """

    patches: list[FormPatch]
    observations: list[Observation]
    metas: list[RoleMeta]
    rejected: list[tuple[FormPatch, RuleViolation]] = field(default_factory=list)
    form: Form | None = None
    task_type: str | None = None
    dropped_segment_ids: list[str] = field(default_factory=list)

    def __iter__(self) -> Iterator[Any]:
        return iter((self.patches, self.observations, self.metas))


async def run_extraction(
    roles_client: RolesClient,
    session_id: str,
    form: Form,
    window: list[TranscriptSegment],
    crew: list[CrewEntry],
    open_gaps: list[Gap],
    recent_observations: list[Observation],
    task_type: str | None,
    *,
    library: HazardLibrary | None = None,
) -> Extraction:
    lib = library or get_library()
    metas: list[RoleMeta] = []
    try:
        analyst = await invoke_role(roles_client, RoleName.CONVERSATION_ANALYST, ConversationAnalystRequest(
            session_id=session_id, window=window, crew=crew, open_gaps=open_gaps,
            recent_observations=recent_observations, task_type=task_type,
        ), ConversationAnalystResponse)
        metas.append(analyst.meta)
        task_type = task_type or analyst.task_type_hint
        if not analyst.observations:
            return Extraction([], [], metas, form=form, task_type=task_type,
                              dropped_segment_ids=analyst.dropped_segment_ids)

        expert = await invoke_role(roles_client, RoleName.HAZARD_EXPERT, HazardExpertRequest(
            session_id=session_id, observations=analyst.observations, task_type=task_type,
            existing_hazard_codes=sorted(form.hazards), include_task_typical=True,
        ), HazardExpertResponse)
        metas.append(expert.meta)
        task_type = expert.task_type or task_type

        filler = await invoke_role(roles_client, RoleName.FORM_FILLER, FormFillerRequest(
            session_id=session_id, draft=form, observations=analyst.observations, assessments=expert.assessments,
        ), FormFillerResponse)
        metas.append(filler.meta)
    except RoleInvocationError as exc:
        exc.metas = metas
        raise

    new_form, applied, rejected = apply_patches(form, filler.patches, lib)
    for patch, violation in rejected:
        log.info("patch_rejected_by_rules", extra={"session_id": session_id, "path": patch.path,
                                                   "rule": violation.rule, "reason": violation.message})
    return Extraction(applied, analyst.observations, metas, rejected=rejected, form=new_form, task_type=task_type,
                      dropped_segment_ids=analyst.dropped_segment_ids)
