"""In-memory registry of session runners, with startup recovery and graceful shutdown.

The orchestrator holds no durable state of its own: after a restart (or on another replica)
runners are rebuilt from the form API, so replicas can be replaced freely.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable

from packages.common.errors import NotFound, UpstreamError

from .clients import FormApi
from .runner import SessionRunner

log = logging.getLogger(__name__)

EVICT_AFTER_S = 1800.0  # finished runners stay visible on /status for a while
RECOVERY_MAX_BACKOFF_S = 60.0


class RunnerRegistry:
    def __init__(self, factory: Callable[[str], SessionRunner], form_api: FormApi):
        self._factory = factory
        self._form_api = form_api
        self._runners: dict[str, SessionRunner] = {}
        self._creating: dict[str, asyncio.Lock] = {}
        self._recovery: asyncio.Task[None] | None = None

    def get(self, session_id: str) -> SessionRunner | None:
        return self._runners.get(session_id)

    async def get_or_create(self, session_id: str) -> SessionRunner:
        if runner := self._runners.get(session_id):
            return runner
        lock = self._creating.setdefault(session_id, asyncio.Lock())
        async with lock:
            if runner := self._runners.get(session_id):
                return runner
            runner = self._factory(session_id)
            try:
                await runner.load()
            except UpstreamError as exc:
                if exc.extra.get("upstream_status") == 404:
                    raise NotFound(f"Session {session_id} not found") from exc
                raise
            self._evict_finished()
            self._runners[session_id] = runner
        self._creating.pop(session_id, None)
        return runner

    def _evict_finished(self) -> None:
        now = time.monotonic()
        for sid, runner in list(self._runners.items()):
            if not runner.running and runner.done_at is not None and now - runner.done_at > EVICT_AFTER_S:
                del self._runners[sid]

    def statuses(self) -> list[dict[str, object]]:
        return [r.status() for r in self._runners.values()]

    def start_recovery(self) -> None:
        self._recovery = asyncio.create_task(self._recover(), name="runner-recovery")

    async def _recover(self) -> None:
        """Resume scheduling for every live session; keep retrying until the form API answers."""
        attempt = 0
        while True:
            try:
                sessions = await self._form_api.live_sessions()
                break
            except Exception as exc:  # noqa: BLE001
                attempt += 1
                delay = min(RECOVERY_MAX_BACKOFF_S, 2.0 * 2 ** min(attempt, 5))
                log.warning("recovery_retry", extra={"attempt": attempt, "retry_in_s": delay, "error": str(exc)})
                await asyncio.sleep(delay)
        for session in sessions:
            try:
                (await self.get_or_create(session.id)).start()
            except Exception:  # noqa: BLE001 - one broken session must not block the others
                log.exception("recovery_failed", extra={"session_id": session.id})
        log.info("recovery_done", extra={"sessions": len(sessions)})

    async def shutdown(self) -> None:
        if self._recovery is not None:
            self._recovery.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._recovery
        await asyncio.gather(*(r.stop() for r in self._runners.values()), return_exceptions=True)
        self._runners.clear()
