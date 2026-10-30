"""Session orchestrator (port 8002, internal only).

A deterministic per-session state machine that schedules the specialist roles. See
``runner.py`` for the timeline and ``pipeline.py`` for the extraction step.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Request
from pydantic import Field

from packages.common.app import create_app
from packages.common.auth import internal_only
from packages.common.config import Settings
from packages.common.errors import NotFound
from packages.common.events import build_publisher
from packages.common.logging import session_id_var
from packages.schemas import Model, RecordingState, TranscriptSegment, get_library

from .clients import FormApiClient, build_roles_client
from .registry import RunnerRegistry
from .runner import SessionRunner

log = logging.getLogger(__name__)

MAX_SEGMENTS_PER_REQUEST = 200
# Callers (form API: 60 s timeout) expect /end to return once the final extraction + verifier ran and
# the session is in REVIEW or the clarification round has started (it never waits for answers).
END_WAIT_S = 40.0


class SegmentsBody(Model):
    segments: list[TranscriptSegment] = Field(max_length=MAX_SEGMENTS_PER_REQUEST)


class RecordingBody(Model):
    recording: RecordingState


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    s: Settings = app.state.settings
    form_api = FormApiClient(s.form_api_url)
    roles = build_roles_client(s)
    publisher = build_publisher(s)
    library = get_library(str(s.hazard_library_path) if s.hazard_library_path else None)

    def factory(session_id: str) -> SessionRunner:
        return SessionRunner(session_id, form_api=form_api, roles=roles, publisher=publisher, settings=s,
                             library=library)

    registry = RunnerRegistry(factory, form_api)
    app.state.registry = registry
    registry.start_recovery()
    log.info("orchestrator_started", extra={"roles_in_process": s.roles_in_process,
                                            "extraction_interval_s": s.extraction_interval_seconds,
                                            "verifier_every_n": s.verifier_every_n_extractions})
    try:
        yield
    finally:
        await registry.shutdown()
        await roles.aclose()
        await publisher.aclose()
        await form_api.aclose()


app = create_app("orchestrator", lifespan=lifespan)
router = APIRouter(prefix="/internal", tags=["internal"], dependencies=[Depends(internal_only)])


def _registry(request: Request) -> RunnerRegistry:
    return request.app.state.registry


async def _runner(request: Request, session_id: str) -> SessionRunner:
    session_id_var.set(session_id)
    return await _registry(request).get_or_create(session_id)


@router.post("/sessions/{session_id}/start")
async def start(session_id: str, request: Request) -> dict[str, Any]:
    (await _runner(request, session_id)).start()
    return {}


@router.post("/sessions/{session_id}/segments")
async def segments(session_id: str, body: SegmentsBody, request: Request) -> dict[str, int]:
    runner = await _runner(request, session_id)
    accepted = await runner.ingest(body.segments)
    runner.start()
    return {"accepted": accepted}


@router.post("/sessions/{session_id}/end")
async def end(session_id: str, request: Request) -> dict[str, Any]:
    runner = await _runner(request, session_id)
    settled = await runner.end(wait_s=END_WAIT_S)
    return {"state": runner.state, "settled": settled}


@router.post("/sessions/{session_id}/finish")
async def finish(session_id: str, request: Request) -> dict[str, Any]:
    """Crew tapped "Done" on the clarification round."""
    runner = await _runner(request, session_id)
    settled = await runner.finish(wait_s=END_WAIT_S)
    return {"state": runner.state, "settled": settled}


@router.post("/sessions/{session_id}/recording")
async def recording(session_id: str, body: RecordingBody, request: Request) -> dict[str, Any]:
    await (await _runner(request, session_id)).set_recording(body.recording)
    return {}


@router.post("/sessions/{session_id}/resume")
async def resume(session_id: str, request: Request) -> dict[str, Any]:
    await (await _runner(request, session_id)).resume()
    return {}


@router.get("/sessions/{session_id}/status")
async def status(session_id: str, request: Request) -> dict[str, Any]:
    runner = _registry(request).get(session_id)
    if runner is None:
        raise NotFound(f"No runner for session {session_id}")
    return runner.status()


@router.get("/runners")
async def runners(request: Request) -> list[dict[str, Any]]:
    return _registry(request).statuses()


app.include_router(router)
