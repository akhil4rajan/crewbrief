"""Roles service (port 8003, internal only): ``POST /roles/<role-name>`` per docs/api/contracts.md."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from packages.common.app import create_app
from packages.common.auth import internal_only
from packages.common.logging import session_id_var
from packages.schemas import (
    ConversationAnalystRequest,
    ConversationAnalystResponse,
    FormFillerRequest,
    FormFillerResponse,
    HazardExpertRequest,
    HazardExpertResponse,
    RoleName,
    VerifierRequest,
    VerifierResponse,
    VoicePrompterRequest,
    VoicePrompterResponse,
)

from .common import library
from .registry import ROLE_HANDLERS

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    from knowledge.search import get_search

    library()  # fail fast on a broken library
    get_search()
    yield


async def _ready() -> bool:
    return bool(library().hazards)


app = create_app("roles", lifespan=lifespan, readiness_checks=[_ready])
internal = [Depends(internal_only)]


async def _run(role: RoleName, request):  # type: ignore[no-untyped-def]
    token = session_id_var.set(request.session_id)
    try:
        response = await ROLE_HANDLERS[role](request)
        log.info("role_invoked", extra={"role": role.value, "provider": response.meta.provider,
                                        "latency_ms": response.meta.latency_ms})
        return response
    finally:
        session_id_var.reset(token)


@app.post("/roles/conversation-analyst", response_model=ConversationAnalystResponse, dependencies=internal)
async def conversation_analyst(body: ConversationAnalystRequest) -> ConversationAnalystResponse:
    return await _run(RoleName.CONVERSATION_ANALYST, body)


@app.post("/roles/hazard-expert", response_model=HazardExpertResponse, dependencies=internal)
async def hazard_expert(body: HazardExpertRequest) -> HazardExpertResponse:
    return await _run(RoleName.HAZARD_EXPERT, body)


@app.post("/roles/form-filler", response_model=FormFillerResponse, dependencies=internal)
async def form_filler(body: FormFillerRequest) -> FormFillerResponse:
    return await _run(RoleName.FORM_FILLER, body)


@app.post("/roles/verifier", response_model=VerifierResponse, dependencies=internal)
async def verifier(body: VerifierRequest) -> VerifierResponse:
    return await _run(RoleName.VERIFIER, body)


@app.post("/roles/voice-prompter", response_model=VoicePrompterResponse, dependencies=internal)
async def voice_prompter(body: VoicePrompterRequest) -> VoicePrompterResponse:
    return await _run(RoleName.VOICE_PROMPTER, body)
