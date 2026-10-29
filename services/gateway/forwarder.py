"""Batches prepared transcript segments to the orchestrator.

Small batches (a few segments or ~250 ms, whichever comes first) keep speech-to-form latency
low without one HTTP call per utterance. Sends are serialised so the orchestrator receives
segments in spoken order. A failed send keeps the batch at the head of the buffer and is
retried with backoff; the orchestrator de-duplicates by segment id, so a retry after a lost
response is harmless.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from packages.common.http import InternalClient
from packages.schemas import TranscriptSegment

log = logging.getLogger(__name__)


class SegmentForwarder:
    def __init__(self, session_id: str, orchestrator: InternalClient, *, max_batch: int = 8,
                 max_delay: float = 0.25, max_buffer: int = 1000):
        self.session_id = session_id
        self._client = orchestrator
        self._max_batch = max_batch
        self._max_delay = max_delay
        self._max_buffer = max_buffer
        self._buffer: list[TranscriptSegment] = []
        self._lock = asyncio.Lock()
        self._timer: asyncio.Task[None] | None = None
        self._failures = 0
        self.forwarded = 0

    async def add(self, segment: TranscriptSegment) -> None:
        if len(self._buffer) >= self._max_buffer:
            dropped = self._buffer.pop(0)
            log.error("segment_buffer_overflow", extra={"session_id": self.session_id, "dropped": dropped.id})
        self._buffer.append(segment)
        if len(self._buffer) >= self._max_batch:
            await self.flush()
        elif self._timer is None or self._timer.done():
            self._timer = asyncio.create_task(self._flush_later(self._max_delay))

    async def _flush_later(self, delay: float) -> None:
        await asyncio.sleep(delay)
        await self.flush()

    async def flush(self) -> bool:
        """Send everything buffered. Returns True when the buffer is empty afterwards."""
        async with self._lock:
            while self._buffer:
                batch = self._buffer[: self._max_batch]
                try:
                    await self._client.post(f"/internal/sessions/{self.session_id}/segments",
                                            json={"segments": [s.model_dump(mode="json") for s in batch]})
                except Exception as exc:  # noqa: BLE001
                    self._failures += 1
                    delay = min(10.0, 0.5 * 2 ** min(self._failures, 5))
                    log.warning("segment_forward_failed", extra={"session_id": self.session_id,
                                                                 "batch": len(batch), "retry_in_s": delay,
                                                                 "error": str(exc)})
                    if self._timer is None or self._timer.done() or self._timer is asyncio.current_task():
                        self._timer = asyncio.create_task(self._flush_later(delay))
                    return False
                del self._buffer[: len(batch)]
                self._failures = 0
                self.forwarded += len(batch)
            return True

    async def aclose(self) -> None:
        """Flush what is left (one attempt) and stop the timer."""
        if self._timer is not None and self._timer is not asyncio.current_task():
            self._timer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._timer
        if not await self.flush():
            log.error("segments_not_forwarded", extra={"session_id": self.session_id,
                                                       "count": len(self._buffer)})
        if self._timer is not None:
            self._timer.cancel()
