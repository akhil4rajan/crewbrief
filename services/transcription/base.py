"""Transcriber contract shared by the gateway and the speech back-ends."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Protocol

from packages.schemas import TranscriptSegment

SegmentCallback = Callable[[TranscriptSegment], Awaitable[None]]

PHRASE_LIST_PATH = Path(__file__).with_name("phrase_list.txt")


class TranscriberUnavailable(RuntimeError):
    """Raised when audio cannot be transcribed in the current mode (e.g. local/offline)."""


class Transcriber(Protocol):
    """Streams PCM audio for one briefing session and emits final transcript segments.

    ``on_segment`` is awaited on the caller's event loop for every final result, in order.
    Implementations must never persist raw audio (``RETAIN_RAW_AUDIO=false`` is the default).
    """

    async def start(self, session_id: str, on_segment: SegmentCallback) -> None: ...

    async def push_audio(self, chunk: bytes) -> None: ...

    async def stop(self) -> None: ...


def load_phrase_list(path: Path = PHRASE_LIST_PATH) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]
