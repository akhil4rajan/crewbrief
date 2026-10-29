"""Service-to-service API used by the orchestrator (``/internal``, ``X-Internal-Token``)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from packages.common.auth import internal_only
from packages.schemas import ApplyPatchesRequest, ApplyPatchesResult, AuditEntry, Gap, Session, TransitionRequest

from ..models import GapsRequest, RecordingRequest, SegmentsRequest, SegmentsStored, SessionContext
from . import Service, parse_states

router = APIRouter(prefix="/internal", tags=["internal"], dependencies=[Depends(internal_only)])


@router.get("/sessions")
async def list_sessions(svc: Service, state: str | None = None,
                        limit: Annotated[int, Query(ge=1, le=5000)] = 1000) -> list[Session]:
    """Orchestrator recovery after a restart, e.g. ``?state=BRIEFING,DRAFTING,GAP_CHECK``."""
    return await svc.list_sessions(states=parse_states(state), member_id=None, limit=limit)


@router.get("/sessions/{session_id}/context")
async def context(session_id: str, svc: Service,
                  transcript_limit: Annotated[int, Query(ge=1, le=5000)] = 200) -> SessionContext:
    return await svc.context(session_id, transcript_limit)


@router.post("/sessions/{session_id}/segments")
async def segments(session_id: str, body: SegmentsRequest, svc: Service) -> SegmentsStored:
    return SegmentsStored(stored=await svc.store_segments(session_id, body.segments))


@router.post("/sessions/{session_id}/patches")
async def patches(session_id: str, body: ApplyPatchesRequest, svc: Service) -> ApplyPatchesResult:
    return await svc.apply_ai_patches(session_id, body)


@router.put("/sessions/{session_id}/gaps")
async def put_gaps(session_id: str, body: GapsRequest, svc: Service) -> list[Gap]:
    return await svc.upsert_gaps(session_id, body.gaps)


@router.post("/sessions/{session_id}/transition")
async def transition(session_id: str, body: TransitionRequest, svc: Service) -> Session:
    return await svc.transition(session_id, body)


@router.post("/sessions/{session_id}/recording")
async def recording(session_id: str, body: RecordingRequest, svc: Service) -> Session:
    return await svc.set_recording(session_id, body.recording)


@router.post("/sessions/{session_id}/audit")
async def audit(session_id: str, body: AuditEntry, svc: Service) -> dict[str, str]:
    await svc.append_audit(session_id, body)
    return {}
