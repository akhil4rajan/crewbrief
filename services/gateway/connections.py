"""WebSocket connection registry with per-connection send queues.

Fan-out never awaits a socket: each connection has its own bounded queue drained by its own
sender task, so one slow phone on a bad mobile link cannot delay events for anyone else.
A connection whose queue overflows is closed (1013, try again later); clients resync from
``GET /api/sessions/{id}`` when they reconnect, which is cheaper and safer than replaying a
partial patch stream.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import defaultdict
from enum import StrEnum

from fastapi import WebSocket
from starlette.websockets import WebSocketState

log = logging.getLogger(__name__)

CLOSE_TRY_AGAIN_LATER = 1013
CLOSE_GOING_AWAY = 1001
FLUSH_TIMEOUT_S = 2.0


class ConnectionKind(StrEnum):
    DEVICE = "device"
    LIVE = "live"


class ClientConnection:
    def __init__(self, ws: WebSocket, session_id: str, user_id: str, kind: ConnectionKind, max_queue: int):
        self.ws = ws
        self.session_id = session_id
        self.user_id = user_id
        self.kind = kind
        self.closed = False
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=max_queue)
        self._sender: asyncio.Task[None] | None = None
        self._closer: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._sender = asyncio.create_task(self._drain(), name=f"ws-send-{self.session_id}-{self.kind}")

    def send(self, message: str) -> bool:
        """Queue a text frame. Never blocks; returns False if the connection is gone or overloaded."""
        if self.closed:
            return False
        try:
            self._queue.put_nowait(message)
            return True
        except asyncio.QueueFull:
            log.warning("ws_slow_consumer_closed", extra={"session_id": self.session_id, "kind": self.kind,
                                                          "user_id": self.user_id})
            self._closer = asyncio.create_task(self.close(CLOSE_TRY_AGAIN_LATER, "slow consumer"))
            return False

    async def _drain(self) -> None:
        try:
            while True:
                message = await self._queue.get()
                await self.ws.send_text(message)
                self._queue.task_done()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - socket already gone; the receive loop cleans up
            log.info("ws_send_failed", extra={"session_id": self.session_id, "error": str(exc)})
            self.closed = True

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self.closed and self._sender is None:
            return
        self.closed = True
        if self._sender is not None:
            self._sender.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._sender
            self._sender = None
        if self.ws.application_state == WebSocketState.CONNECTED:
            with contextlib.suppress(Exception):
                await self.ws.close(code=code, reason=reason)

    async def flush(self) -> None:
        """Best effort: give queued frames a moment to go out before a deliberate close."""
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(FLUSH_TIMEOUT_S):
                await self._queue.join()


class ConnectionManager:
    def __init__(self, max_queue: int = 256):
        self._max_queue = max_queue
        self._by_session: dict[str, set[ClientConnection]] = defaultdict(set)

    def register(self, ws: WebSocket, session_id: str, user_id: str, kind: ConnectionKind) -> ClientConnection:
        conn = ClientConnection(ws, session_id, user_id, kind, self._max_queue)
        conn.start()
        self._by_session[session_id].add(conn)
        log.info("ws_connected", extra={"session_id": session_id, "kind": kind, "user_id": user_id,
                                        "session_connections": len(self._by_session[session_id])})
        return conn

    async def unregister(self, conn: ClientConnection) -> None:
        conns = self._by_session.get(conn.session_id)
        if conns is not None:
            conns.discard(conn)
            if not conns:
                del self._by_session[conn.session_id]
        await conn.close()
        log.info("ws_disconnected", extra={"session_id": conn.session_id, "kind": conn.kind,
                                           "user_id": conn.user_id})

    def broadcast(self, session_id: str, message: str) -> int:
        delivered = 0
        for conn in list(self._by_session.get(session_id, ())):
            delivered += conn.send(message)
        return delivered

    def stats(self) -> dict[str, int]:
        return {"sessions": len(self._by_session),
                "connections": sum(len(c) for c in self._by_session.values())}

    async def close_all(self) -> None:
        conns = [c for group in self._by_session.values() for c in group]
        self._by_session.clear()
        await asyncio.gather(*(c.close(CLOSE_GOING_AWAY, "server shutting down") for c in conns),
                             return_exceptions=True)
