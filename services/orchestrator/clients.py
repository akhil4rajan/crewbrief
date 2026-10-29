"""Clients the session runner depends on, behind small Protocols so they can be swapped
(HTTP vs in-process roles) or faked when the runner is driven in-process."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

from packages.common.config import Settings
from packages.common.errors import UpstreamError
from packages.common.http import InternalClient
from packages.schemas import (
    ApplyPatchesRequest,
    ApplyPatchesResult,
    AuditEntry,
    ConversationAnalystResponse,
    Draft,
    FormFillerResponse,
    Gap,
    HazardExpertResponse,
    Model,
    RecordingState,
    RoleName,
    Session,
    SessionState,
    TranscriptSegment,
    TransitionRequest,
    VerifierResponse,
    VoicePrompterResponse,
)

log = logging.getLogger(__name__)

RESPONSE_MODELS: dict[RoleName, type[Model]] = {
    RoleName.CONVERSATION_ANALYST: ConversationAnalystResponse,
    RoleName.HAZARD_EXPERT: HazardExpertResponse,
    RoleName.FORM_FILLER: FormFillerResponse,
    RoleName.VERIFIER: VerifierResponse,
    RoleName.VOICE_PROMPTER: VoicePrompterResponse,
}


# --- Roles ---------------------------------------------------------------------------------


class RolesClient(Protocol):
    async def invoke(self, role: RoleName, request: Model) -> Model: ...

    async def aclose(self) -> None: ...


class HttpRolesClient:
    """``POST {ROLES_URL}/roles/<role-name>``. One retry only: a slow LLM is retried by the next tick."""

    def __init__(self, base_url: str, timeout: float):
        self._http = InternalClient(base_url, timeout=timeout, retries=1, name="roles")

    async def invoke(self, role: RoleName, request: Model) -> Model:
        data = await self._http.post(f"/roles/{role.value}", json=request.model_dump(mode="json"))
        return RESPONSE_MODELS[role].model_validate(data)

    async def aclose(self) -> None:
        await self._http.aclose()


class InProcessRolesClient:
    """Calls ``services.roles.registry.ROLE_HANDLERS`` directly (single-process deployments, eval)."""

    def __init__(self) -> None:
        self._handlers: dict[RoleName, Any] | None = None

    async def invoke(self, role: RoleName, request: Model) -> Model:
        if self._handlers is None:
            from services.roles.registry import ROLE_HANDLERS  # lazy: roles pull in LLM/search deps

            self._handlers = ROLE_HANDLERS
        response = await self._handlers[role](request)
        model = RESPONSE_MODELS[role]
        return response if isinstance(response, model) else model.model_validate(response)

    async def aclose(self) -> None:
        return None


def build_roles_client(settings: Settings) -> RolesClient:
    if settings.roles_in_process:
        return InProcessRolesClient()
    return HttpRolesClient(settings.roles_url, timeout=settings.llm_timeout_seconds + 10.0)


# --- Form API ------------------------------------------------------------------------------


@dataclass
class SessionContext:
    session: Session
    draft: Draft
    gaps: list[Gap]
    transcript: list[TranscriptSegment]


class FormApi(Protocol):
    async def context(self, session_id: str, transcript_limit: int = 200) -> SessionContext: ...
    async def store_segments(self, session_id: str, segments: list[TranscriptSegment]) -> int: ...
    async def apply_patches(self, session_id: str, request: ApplyPatchesRequest) -> ApplyPatchesResult: ...
    async def put_gaps(self, session_id: str, gaps: list[Gap]) -> list[Gap]: ...
    async def transition(self, session_id: str, to: SessionState, reason: str) -> Session: ...
    async def set_recording(self, session_id: str, recording: RecordingState) -> Session: ...
    async def audit(self, session_id: str, entry: AuditEntry) -> None: ...
    async def live_sessions(self) -> list[Session]: ...


class FormApiClient:
    """Internal (``/internal``) surface of the form API, which owns all persisted session state."""

    def __init__(self, base_url: str):
        self._http = InternalClient(base_url, timeout=10.0, retries=3, name="form-api")

    async def context(self, session_id: str, transcript_limit: int = 200) -> SessionContext:
        data = await self._http.get(f"/internal/sessions/{session_id}/context",
                                    params={"transcript_limit": transcript_limit})
        return SessionContext(
            session=Session.model_validate(data["session"]),
            draft=Draft.model_validate(data["draft"]),
            gaps=[Gap.model_validate(g) for g in data.get("gaps") or []],
            transcript=[TranscriptSegment.model_validate(t) for t in data.get("transcript") or []],
        )

    async def store_segments(self, session_id: str, segments: list[TranscriptSegment]) -> int:
        data = await self._http.post(f"/internal/sessions/{session_id}/segments",
                                     json={"segments": [s.model_dump(mode="json") for s in segments]})
        return int((data or {}).get("stored", len(segments)))

    async def apply_patches(self, session_id: str, request: ApplyPatchesRequest) -> ApplyPatchesResult:
        data = await self._http.post(f"/internal/sessions/{session_id}/patches", json=request.model_dump(mode="json"))
        return ApplyPatchesResult.model_validate(data)

    async def put_gaps(self, session_id: str, gaps: list[Gap]) -> list[Gap]:
        data = await self._http.put(f"/internal/sessions/{session_id}/gaps",
                                    json={"gaps": [g.model_dump(mode="json") for g in gaps]})
        return [Gap.model_validate(g) for g in data or []]

    async def transition(self, session_id: str, to: SessionState, reason: str) -> Session:
        body = TransitionRequest(to=to, reason=reason).model_dump(mode="json")
        return Session.model_validate(await self._http.post(f"/internal/sessions/{session_id}/transition", json=body))

    async def set_recording(self, session_id: str, recording: RecordingState) -> Session:
        data = await self._http.post(f"/internal/sessions/{session_id}/recording",
                                     json={"recording": recording.value})
        return Session.model_validate(data)

    async def audit(self, session_id: str, entry: AuditEntry) -> None:
        """Best effort: a lost audit write is logged loudly but never fails the pipeline."""
        try:
            await self._http.post(f"/internal/sessions/{session_id}/audit", json=entry.model_dump(mode="json"))
        except UpstreamError as exc:
            log.error("audit_write_failed", extra={"session_id": session_id, "action": entry.action,
                                                   "error": str(exc)})

    async def live_sessions(self) -> list[Session]:
        states = ",".join(s.value for s in (SessionState.BRIEFING, SessionState.DRAFTING, SessionState.GAP_CHECK))
        data = await self._http.get("/internal/sessions", params={"state": states})
        return [Session.model_validate(s) for s in data or []]

    async def aclose(self) -> None:
        await self._http.aclose()
