"""Ordered, non-blocking event emission.

Writes enqueue events after they commit; background workers publish them via
``packages.common.events``. Events of one session always go to the same worker, so clients
see them in commit order. Publishing is best-effort: a full queue drops the event (clients
resync from ``GET /api/sessions/{id}``) rather than slowing down or failing the write.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import zlib
from typing import Any

from packages.common.events import EventPublisher
from packages.schemas import EventEnvelope, EventType

log = logging.getLogger(__name__)


class EventBus:
    def __init__(self, publisher: EventPublisher, *, workers: int = 4, queue_size: int = 5000):
        self._publisher = publisher
        self._queues: list[asyncio.Queue[EventEnvelope | None]] = [asyncio.Queue(queue_size) for _ in range(workers)]
        self._tasks: list[asyncio.Task[None]] = []

    def start(self) -> None:
        self._tasks = [asyncio.create_task(self._run(q), name=f"form-api-events-{i}")
                       for i, q in enumerate(self._queues)]

    def emit(self, type: EventType, session_id: str, payload: dict[str, Any]) -> None:
        event = EventEnvelope(type=type, session_id=session_id, payload=payload)
        queue = self._queues[zlib.crc32(session_id.encode()) % len(self._queues)]
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            log.warning("event_dropped_queue_full", extra={"type": str(type), "session_id": session_id})

    async def _run(self, queue: asyncio.Queue[EventEnvelope | None]) -> None:
        while (event := await queue.get()) is not None:
            try:
                await self._publisher.publish(event)
            except Exception as exc:  # noqa: BLE001 - publishers are best-effort; never kill the worker
                log.warning("event_publish_failed", extra={"type": str(event.type), "error": str(exc)})

    async def aclose(self, drain_seconds: float = 5.0) -> None:
        """Drain what is queued (bounded by ``drain_seconds``), then stop."""
        for queue in self._queues:
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(None)
        if self._tasks:
            _, pending = await asyncio.wait(self._tasks, timeout=drain_seconds)
            for task in pending:
                task.cancel()
        await self._publisher.aclose()
