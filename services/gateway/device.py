"""Device WebSocket protocol handler (one instance per connected crew device).

See docs/api/contracts.md "Device WebSocket protocol". Responsibilities:

* audio mode: PCM16 frames → transcriber (Azure ``ConversationTranscriber``); in local mode
  one ``error`` event ``stt_unavailable_local`` is sent and the device switches to text mode
* text mode: ``transcript`` messages → ``TranscriptSegment(source=device_text)``
* every segment is PII-redacted, filtered (kept for audit) and batched to the orchestrator
* pause / resume / end → orchestrator; ping → pong

Raw audio only ever lives in memory on its way to the speech service; nothing is written
to disk (``RETAIN_RAW_AUDIO=false``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from packages.common.config import Settings
from packages.common.http import InternalClient
from packages.schemas import EventEnvelope, EventType, RecordingState, SegmentSource, TranscriptSegment, User
from services.transcription import (
    PiiRedactor,
    Transcriber,
    TranscriberUnavailable,
    apply_filters,
    build_transcriber,
    redact_segment,
)

from .connections import ClientConnection
from .forwarder import SegmentForwarder

log = logging.getLogger(__name__)

MAX_TEXT_FRAME_BYTES = 16 * 1024
MAX_AUDIO_FRAME_BYTES = 64 * 1024
MAX_TRANSCRIPT_CHARS = 2000
DEVICE_IDLE_TIMEOUT_S = 90.0
SUPPORTED_SAMPLE_RATES = (8000, 16000)
_USER_ID = re.compile(r"^[\w.@:-]{1,64}$")
UNKNOWN_SPEAKER = "Unknown"


# End requests outlive the socket that sent them (the device may hang up right after "end").
_background: set[asyncio.Task[None]] = set()


@dataclass
class GatewayDeps:
    settings: Settings
    orchestrator: InternalClient  # short timeout: segments, recording
    orchestrator_control: InternalClient  # long timeout: /end waits for the final extraction
    redactor: PiiRedactor | None


class DeviceSession:
    def __init__(self, conn: ClientConnection, user: User, deps: GatewayDeps):
        self.conn = conn
        self.session_id = conn.session_id
        self.user = user
        self.deps = deps
        self.mode: str | None = None
        self.device_id: str | None = None
        self.paused = False
        self.ended = False
        self._transcriber: Transcriber | None = None
        self._stt_unavailable_sent = False
        self._warned: set[str] = set()
        self._segment_lock = asyncio.Lock()
        self._forwarder = SegmentForwarder(self.session_id, deps.orchestrator)

    # --- outbound -----------------------------------------------------------------------

    def _send(self, payload: dict[str, Any]) -> None:
        self.conn.send(json.dumps(payload))

    def _error(self, code: str, message: str, *, once: bool = False) -> None:
        if once:
            if code in self._warned:
                return
            self._warned.add(code)
        event = EventEnvelope(type=EventType.ERROR, session_id=self.session_id,
                              payload={"code": code, "message": message})
        self.conn.send(event.model_dump_json())

    # --- main loop ----------------------------------------------------------------------

    async def run(self) -> None:
        ws = self.conn.ws
        try:
            while True:
                try:
                    message = await asyncio.wait_for(ws.receive(), timeout=DEVICE_IDLE_TIMEOUT_S)
                except TimeoutError:
                    self._error("idle_timeout", f"No message for {int(DEVICE_IDLE_TIMEOUT_S)}s; send ping")
                    await self.conn.flush()
                    break
                if message["type"] == "websocket.disconnect":
                    break
                if (data := message.get("bytes")) is not None:
                    await self._on_audio(data)
                elif (text := message.get("text")) is not None:
                    await self._on_text(text)
        finally:
            await self._cleanup()

    async def _on_text(self, raw: str) -> None:
        if len(raw.encode()) > MAX_TEXT_FRAME_BYTES:
            self._error("message_too_large", f"Text frames are limited to {MAX_TEXT_FRAME_BYTES} bytes")
            return
        try:
            msg = json.loads(raw)
            kind = msg["type"]
        except (ValueError, KeyError, TypeError):
            self._error("invalid_message", "Expected a JSON object with a 'type'")
            return
        handler = {
            "start": self._on_start, "transcript": self._on_transcript, "pause": self._on_pause,
            "resume": self._on_resume, "end": self._on_end, "ping": self._on_ping,
        }.get(kind)
        if handler is None:
            self._error("unknown_type", f"Unknown message type {kind!r}")
            return
        await handler(msg)

    # --- protocol handlers --------------------------------------------------------------

    async def _on_ping(self, _: dict[str, Any]) -> None:
        self._send({"type": "pong"})

    async def _on_start(self, msg: dict[str, Any]) -> None:
        mode = msg.get("mode", "text")
        if mode not in ("audio", "text"):
            self._error("invalid_message", "mode must be 'audio' or 'text'")
            return
        sample_rate = msg.get("sample_rate", 16000)
        if mode == "audio" and (msg.get("encoding", "pcm16") != "pcm16" or sample_rate not in SUPPORTED_SAMPLE_RATES):
            self._error("unsupported_audio", f"Audio must be pcm16 at one of {SUPPORTED_SAMPLE_RATES} Hz")
            return
        if self.ended:
            self._error("session_ended", "This briefing has ended")
            return
        # A device may switch modes mid-session (e.g. audio → text after stt_unavailable_local).
        await self._stop_transcriber()
        self.mode = mode
        self.device_id = str(msg.get("device_id") or "")[:64] or None
        if mode == "audio":
            await self._start_transcriber(sample_rate)
        self.paused = False
        await self._notify_recording(RecordingState.ACTIVE)
        self._send({"type": "ready", "session_id": self.session_id, "mode": mode})
        log.info("device_started", extra={"session_id": self.session_id, "mode": mode, "device_id": self.device_id,
                                          "user_id": self.user.id})

    async def _start_transcriber(self, sample_rate: int) -> None:
        try:
            transcriber = build_transcriber(self.deps.settings, sample_rate=sample_rate)
            await transcriber.start(self.session_id, self._process_segment)
            self._transcriber = transcriber
        except TranscriberUnavailable:
            self._transcriber = None  # reported on the first audio frame, per protocol
        except Exception as exc:  # noqa: BLE001
            log.exception("stt_start_failed", extra={"session_id": self.session_id})
            self._error("stt_failed", f"Speech service unavailable ({type(exc).__name__}); switch to text mode")

    async def _on_audio(self, data: bytes) -> None:
        if self.mode != "audio":
            self._error("unexpected_audio", "Send start with mode 'audio' before audio frames", once=True)
            return
        if len(data) > MAX_AUDIO_FRAME_BYTES:
            self._error("message_too_large", f"Audio frames are limited to {MAX_AUDIO_FRAME_BYTES} bytes", once=True)
            return
        if self.paused or self.ended:
            return  # recording paused: audio is discarded, never buffered
        if self._transcriber is None:
            if not self._stt_unavailable_sent:
                self._stt_unavailable_sent = True
                self._error("stt_unavailable_local",
                            "Audio cannot be transcribed in local mode; switch to text mode")
            return
        await self._transcriber.push_audio(data)

    async def _on_transcript(self, msg: dict[str, Any]) -> None:
        if self.mode is None:
            self._error("not_started", "Send start before transcript messages", once=True)
            return
        if self.ended or self.paused:
            return
        text = msg.get("text")
        speaker = msg.get("speaker_user_id")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TRANSCRIPT_CHARS:
            self._error("invalid_message", f"transcript.text must be 1..{MAX_TRANSCRIPT_CHARS} characters")
            return
        if speaker is not None and (not isinstance(speaker, str) or not _USER_ID.match(speaker)):
            self._error("invalid_message", "speaker_user_id is not a valid user id")
            return
        try:
            confidence = min(1.0, max(0.0, float(msg.get("confidence", 1.0))))
            start_ms = max(0, int(msg.get("start_ms", 0)))
            end_ms = max(start_ms, int(msg.get("end_ms", start_ms)))
        except (TypeError, ValueError):
            self._error("invalid_message", "confidence/start_ms/end_ms must be numbers")
            return
        segment = TranscriptSegment(
            session_id=self.session_id, speaker_id=speaker or UNKNOWN_SPEAKER, user_id=speaker,
            text=text.strip(), start_ms=start_ms, end_ms=end_ms, confidence=confidence,
            language=self.deps.settings.speech_language, source=SegmentSource.DEVICE_TEXT,
        )
        await self._process_segment(segment)

    async def _on_pause(self, _: dict[str, Any]) -> None:
        if not self.ended and not self.paused:
            self.paused = True
            await self._forwarder.flush()
            await self._notify_recording(RecordingState.PAUSED)

    async def _on_resume(self, _: dict[str, Any]) -> None:
        if not self.ended and self.paused:
            self.paused = False
            await self._notify_recording(RecordingState.ACTIVE)

    async def _on_end(self, _: dict[str, Any]) -> None:
        if self.ended:
            return
        self.ended = True
        # Order matters: final STT results → forwarded segments → end, so the orchestrator's
        # final extraction sees everything that was said.
        await self._stop_transcriber()
        await self._forwarder.flush()
        # The final extraction can take a while; keep the receive loop (pings) responsive meanwhile.
        task = asyncio.create_task(self._request_end(), name=f"end-{self.session_id}")
        _background.add(task)
        task.add_done_callback(_background.discard)

    async def _request_end(self) -> None:
        try:
            await self.deps.orchestrator_control.post(f"/internal/sessions/{self.session_id}/end")
            log.info("device_ended_briefing", extra={"session_id": self.session_id, "user_id": self.user.id})
        except Exception as exc:  # noqa: BLE001
            log.warning("end_forward_failed", extra={"session_id": self.session_id, "error": str(exc)})
            self.ended = False
            self._error("end_failed", "Could not end the briefing; try again")

    # --- segments -----------------------------------------------------------------------

    async def _process_segment(self, segment: TranscriptSegment) -> None:
        """Redact → filter → forward. Serialised so segments keep their spoken order."""
        async with self._segment_lock:
            segment = await redact_segment(segment, self.deps.redactor)
            segment = apply_filters(segment, self.deps.settings.stt_min_confidence)
            await self._forwarder.add(segment)

    # --- lifecycle ----------------------------------------------------------------------

    async def _notify_recording(self, state: RecordingState) -> None:
        try:
            await self.deps.orchestrator.post(f"/internal/sessions/{self.session_id}/recording",
                                              json={"recording": state.value})
        except Exception as exc:  # noqa: BLE001 - the stream itself must keep working
            log.warning("recording_forward_failed", extra={"session_id": self.session_id,
                                                           "recording": state.value, "error": str(exc)})

    async def _stop_transcriber(self) -> None:
        if self._transcriber is None:
            return
        transcriber, self._transcriber = self._transcriber, None
        try:
            await transcriber.stop()
        except Exception:  # noqa: BLE001
            log.exception("stt_stop_failed", extra={"session_id": self.session_id})

    async def _cleanup(self) -> None:
        await self._stop_transcriber()
        await self._forwarder.aclose()
        # A dropped connection is not an "end": the device may reconnect and carry on. The
        # recording indicator must not claim we are still listening, though.
        if self.mode is not None and not self.ended and not self.paused:
            await self._notify_recording(RecordingState.IDLE)
