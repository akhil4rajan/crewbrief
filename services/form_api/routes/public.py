"""Public REST API for the crew app and the review portal (``/api``, bearer token)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Depends, Query

from packages.common.auth import CurrentUser, require_roles
from packages.schemas import (
    AbandonRequest,
    ApplyPatchesRequest,
    ApplyPatchesResult,
    AuditEntry,
    CreateSessionRequest,
    Draft,
    Gap,
    HazardLibrary,
    Session,
    SignOffRequest,
    TranscriptSegment,
    User,
    UserRole,
)

from ..models import CheckInRequest, DiffResponse, DismissGapRequest, EditRateResponse, SessionDetail, Tombstone
from . import Service, parse_states

router = APIRouter(prefix="/api", tags=["form-api"])

Crew = Annotated[User, Depends(require_roles(UserRole.CREW))]
CrewOrSupervisor = Annotated[User, Depends(require_roles(UserRole.CREW, UserRole.SUPERVISOR))]
Supervisor = Annotated[User, Depends(require_roles(UserRole.SUPERVISOR))]
# can_sign_off also lets a safety admin sign; the rule decides, the route only filters out crew.
Signer = Annotated[User, Depends(require_roles(UserRole.SUPERVISOR, UserRole.SAFETY_ADMIN))]
Reviewer = Annotated[User, Depends(require_roles(UserRole.SUPERVISOR, UserRole.SAFETY_ADMIN))]
SafetyAdmin = Annotated[User, Depends(require_roles(UserRole.SAFETY_ADMIN))]


# ---------------------------------------------------------------- users & reference data


@router.get("/me")
async def me(user: CurrentUser, svc: Service) -> User:
    return svc.directory.get(user.id) or user


@router.get("/users")
async def users(_: CurrentUser, svc: Service, role: UserRole | None = None) -> list[User]:
    return svc.directory.list(role)


@router.get("/library")
async def library(_: CurrentUser, svc: Service) -> HazardLibrary:
    return svc.library


# ---------------------------------------------------------------- sessions


@router.post("/sessions", status_code=201)
async def create_session(body: CreateSessionRequest, user: CrewOrSupervisor, svc: Service) -> SessionDetail:
    return await svc.create_session(user, body)


@router.get("/sessions")
async def list_sessions(user: CurrentUser, svc: Service, state: str | None = None, mine: bool = False,
                        limit: Annotated[int, Query(ge=1, le=500)] = 100) -> list[Session]:
    return await svc.list_sessions(states=parse_states(state), member_id=user.id if mine else None, limit=limit)


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, _: CurrentUser, svc: Service) -> SessionDetail:
    return await svc.detail(session_id)


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, user: SafetyAdmin, svc: Service,
                         reason: Annotated[str, Query(min_length=1, max_length=500)] = "retention policy"
                         ) -> Tombstone:
    """Data deletion path (retention / erasure requests): purges transcript and draft content."""
    return await svc.delete_session(user, session_id, reason)


@router.post("/sessions/{session_id}/check-in")
async def check_in(session_id: str, user: Crew, svc: Service,
                   body: Annotated[CheckInRequest | None, Body()] = None) -> SessionDetail:
    return await svc.check_in(user, session_id, body.user_id if body else None)


@router.post("/sessions/{session_id}/acknowledge")
async def acknowledge(session_id: str, user: Crew, svc: Service) -> SessionDetail:
    return await svc.acknowledge_form(user, session_id)


@router.post("/sessions/{session_id}/consent")
async def consent(session_id: str, user: Crew, svc: Service) -> Session:
    return await svc.acknowledge_consent(user, session_id)


@router.post("/sessions/{session_id}/start")
async def start(session_id: str, user: Crew, svc: Service) -> Session:
    return await svc.start(user, session_id)


@router.post("/sessions/{session_id}/end-briefing")
async def end_briefing(session_id: str, user: CrewOrSupervisor, svc: Service) -> Session:
    return await svc.end_briefing(user, session_id)


@router.post("/sessions/{session_id}/resume-briefing")
async def resume_briefing(session_id: str, user: Supervisor, svc: Service) -> Session:
    return await svc.resume_briefing(user, session_id)


@router.post("/sessions/{session_id}/abandon")
async def abandon(session_id: str, body: AbandonRequest, user: CrewOrSupervisor, svc: Service) -> Session:
    return await svc.abandon(user, session_id, body)


# ---------------------------------------------------------------- draft, transcript, gaps


@router.get("/sessions/{session_id}/draft")
async def get_draft(session_id: str, _: CurrentUser, svc: Service) -> Draft:
    return await svc.get_draft(session_id)


@router.patch("/sessions/{session_id}/draft")
async def patch_draft(session_id: str, body: ApplyPatchesRequest, user: CrewOrSupervisor,
                      svc: Service) -> ApplyPatchesResult:
    return await svc.apply_human_patches(user, session_id, body)


@router.get("/sessions/{session_id}/transcript")
async def transcript(session_id: str, _: CurrentUser, svc: Service,
                     limit: Annotated[int | None, Query(ge=1, le=5000)] = None) -> list[TranscriptSegment]:
    return await svc.transcript(session_id, limit)


@router.get("/sessions/{session_id}/gaps")
async def gaps(session_id: str, _: CurrentUser, svc: Service) -> list[Gap]:
    return await svc.gaps(session_id)


@router.post("/sessions/{session_id}/gaps/{gap_id}/dismiss")
async def dismiss_gap(session_id: str, gap_id: str, body: DismissGapRequest, user: Supervisor,
                      svc: Service) -> Gap:
    return await svc.dismiss_gap(user, session_id, gap_id, body.reason)


# ---------------------------------------------------------------- sign-off, submission, accuracy


@router.post("/sessions/{session_id}/sign-off")
async def sign_off(session_id: str, body: SignOffRequest, user: Signer, svc: Service) -> Session:
    return await svc.sign_off(user, session_id, body)


@router.post("/sessions/{session_id}/submit")
async def submit(session_id: str, user: Supervisor, svc: Service) -> Session:
    return await svc.submit(user, session_id)


@router.get("/sessions/{session_id}/audit")
async def audit(session_id: str, _: Reviewer, svc: Service) -> list[AuditEntry]:
    return await svc.audit_log(session_id)


@router.get("/sessions/{session_id}/diff")
async def diff(session_id: str, _: Reviewer, svc: Service) -> DiffResponse:
    return await svc.diff(session_id)


@router.get("/metrics/edit-rate")
async def edit_rate(_: Reviewer, svc: Service,
                    limit: Annotated[int, Query(ge=1, le=5000)] = 1000) -> EditRateResponse:
    return await svc.edit_rate(limit)
