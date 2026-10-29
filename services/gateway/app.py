"""Realtime gateway (port 8000).

Terminates device and live-view WebSockets, hosts the transcription library, hands
transcript segments to the orchestrator and fans events out to connected clients.

In azure mode, live events are delivered by Azure Web PubSub (clients get the URL from
``negotiate``); the gateway still terminates the device audio socket.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote

from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect

from packages.common.app import create_app
from packages.common.auth import CurrentUser, decode_token, internal_only
from packages.common.config import Provider, Settings, get_settings
from packages.common.errors import NotFound, Unauthorized, UpstreamError
from packages.common.http import InternalClient
from packages.common.logging import correlation_id, session_id_var
from packages.schemas import EventEnvelope, Session, User, UserRole, group_name
from services.transcription import build_redactor

from .connections import ConnectionKind, ConnectionManager
from .device import DeviceSession, GatewayDeps

log = logging.getLogger(__name__)

CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_CONFLICT = 4409
CLOSE_UNAVAILABLE = 1011

DEVICE_ROLES = (UserRole.CREW, UserRole.SUPERVISOR)
DEVICE_ACCEPTING_STATES = {"BRIEFING", "DRAFTING", "GAP_CHECK"}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    s: Settings = app.state.settings
    app.state.connections = ConnectionManager()
    app.state.orchestrator = InternalClient(s.orchestrator_url, timeout=5.0, retries=2, name="orchestrator")
    app.state.orchestrator_control = InternalClient(s.orchestrator_url, timeout=60.0, retries=1,
                                                    name="orchestrator-control")
    app.state.form_api = InternalClient(s.form_api_url, timeout=5.0, retries=1, name="form-api")
    app.state.redactor = build_redactor(s)
    app.state.webpubsub = None
    log.info("gateway_started", extra={"mode": s.mode.value, "stt": s.provider("stt").value,
                                       "pubsub": s.provider("pubsub").value, "pii_redaction": s.pii_redaction,
                                       "retain_raw_audio": s.retain_raw_audio})
    try:
        yield
    finally:
        await app.state.connections.close_all()
        await app.state.orchestrator.aclose()
        await app.state.orchestrator_control.aclose()
        await app.state.form_api.aclose()
        if app.state.redactor is not None:
            await app.state.redactor.aclose()
        if app.state.webpubsub is not None:
            await app.state.webpubsub.close()


app = create_app("gateway", lifespan=lifespan)


# --- helpers ------------------------------------------------------------------------------


async def _load_session(form_api: InternalClient, session_id: str) -> Session | None:
    try:
        ctx = await form_api.get(f"/internal/sessions/{session_id}/context", params={"transcript_limit": 1})
    except UpstreamError as exc:
        if exc.extra.get("upstream_status") == 404:
            return None
        raise
    return Session.model_validate(ctx["session"])


async def _accept_authenticated(ws: WebSocket, session_id: str) -> User | None:
    """Accept the socket, then authenticate; failures close with a 44xx code the client can read."""
    correlation_id.set(uuid.uuid4().hex)
    session_id_var.set(session_id)
    await ws.accept()
    try:
        return decode_token(ws.query_params.get("access_token") or "")
    except Unauthorized as exc:
        await ws.close(code=CLOSE_UNAUTHORIZED, reason=exc.detail[:120])
        return None


async def _check_session(ws: WebSocket, session_id: str) -> Session | None:
    try:
        session = await _load_session(ws.app.state.form_api, session_id)
    except UpstreamError:
        log.exception("session_lookup_failed", extra={"session_id": session_id})
        await ws.close(code=CLOSE_UNAVAILABLE, reason="session lookup failed")
        return None
    if session is None:
        await ws.close(code=CLOSE_NOT_FOUND, reason="session not found")
    return session


# --- WebSockets ---------------------------------------------------------------------------


@app.websocket("/ws/device/{session_id}")
async def device_socket(ws: WebSocket, session_id: str) -> None:
    user = await _accept_authenticated(ws, session_id)
    if user is None:
        return
    if not user.has_role(*DEVICE_ROLES):
        await ws.close(code=CLOSE_FORBIDDEN, reason="crew or supervisor role required")
        return
    session = await _check_session(ws, session_id)
    if session is None:
        return
    is_member = user.id in session.crew_member_ids or user.id == session.created_by
    if not (is_member or user.has_role(UserRole.SUPERVISOR)):
        await ws.close(code=CLOSE_FORBIDDEN, reason="not a crew member of this session")
        return
    if session.state.value not in DEVICE_ACCEPTING_STATES:
        await ws.close(code=CLOSE_CONFLICT, reason=f"session is {session.state.value}; start it first")
        return

    manager: ConnectionManager = ws.app.state.connections
    conn = manager.register(ws, session_id, user.id, ConnectionKind.DEVICE)
    deps = GatewayDeps(settings=ws.app.state.settings, orchestrator=ws.app.state.orchestrator,
                       orchestrator_control=ws.app.state.orchestrator_control, redactor=ws.app.state.redactor)
    try:
        await DeviceSession(conn, user, deps).run()
    finally:
        await manager.unregister(conn)


@app.websocket("/ws/live/{session_id}")
async def live_socket(ws: WebSocket, session_id: str) -> None:
    """Read-only event stream for the review portal and crew app (local pub/sub)."""
    user = await _accept_authenticated(ws, session_id)
    if user is None:
        return
    if await _check_session(ws, session_id) is None:
        return
    manager: ConnectionManager = ws.app.state.connections
    conn = manager.register(ws, session_id, user.id, ConnectionKind.LIVE)
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) <= 1024 and _is_ping(raw):
                conn.send(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        await manager.unregister(conn)


def _is_ping(raw: str) -> bool:
    try:
        return json.loads(raw).get("type") == "ping"
    except (ValueError, AttributeError):
        return False


# --- HTTP ---------------------------------------------------------------------------------


def _raw_token(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query_params.get("access_token", "")


async def _webpubsub_url(app_: FastAPI, session_id: str, user: User) -> str:
    s: Settings = app_.state.settings
    if app_.state.webpubsub is None:
        from azure.messaging.webpubsubservice.aio import WebPubSubServiceClient  # type: ignore[import-not-found]

        if not Settings.is_dummy(s.webpubsub_key):
            from azure.core.credentials import AzureKeyCredential  # type: ignore[import-not-found]

            credential: Any = AzureKeyCredential(s.webpubsub_key.get_secret_value())
        else:
            from azure.identity.aio import DefaultAzureCredential  # type: ignore[import-not-found]

            credential = DefaultAzureCredential()
        app_.state.webpubsub = WebPubSubServiceClient(endpoint=s.webpubsub_endpoint, hub=s.webpubsub_hub,
                                                      credential=credential)
    group = group_name(session_id)
    token = await app_.state.webpubsub.get_client_access_token(
        user_id=user.id, groups=[group], roles=[f"webpubsub.joinLeaveGroup.{group}"], minutes_to_expire=60)
    return token["url"]


@app.get("/api/sessions/{session_id}/negotiate", tags=["realtime"])
async def negotiate(session_id: str, request: Request, user: CurrentUser) -> dict[str, str]:
    """Where to subscribe for live events, so clients never need to know the deployment mode."""
    if await _load_session(request.app.state.form_api, session_id) is None:
        raise NotFound(f"Session {session_id} not found")
    s: Settings = request.app.state.settings
    if s.provider("pubsub") == Provider.AZURE:
        return {"url": await _webpubsub_url(request.app, session_id, user)}
    base = s.public_gateway_ws_url.rstrip("/")
    return {"url": f"{base}/ws/live/{session_id}?access_token={quote(_raw_token(request), safe='')}"}


@app.post("/internal/events", tags=["internal"], dependencies=[Depends(internal_only)])
async def publish_event(event: EventEnvelope, request: Request) -> dict[str, int]:
    manager: ConnectionManager = request.app.state.connections
    delivered = manager.broadcast(event.session_id, event.model_dump_json())
    return {"delivered": delivered}


@app.get("/internal/stats", tags=["internal"], dependencies=[Depends(internal_only)])
async def stats(request: Request) -> dict[str, int]:
    return request.app.state.connections.stats()


__all__ = ["app", "get_settings"]
