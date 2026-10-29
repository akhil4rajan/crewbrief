from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import Field

from .common import Model, new_id, utcnow


class SegmentSource(StrEnum):
    AZURE_STT = "azure_stt"  # Azure AI Speech ConversationTranscriber
    DEVICE_TEXT = "device_text"  # text sent by the device (local mode / on-device speech recognition)
    REPLAY = "replay"  # scripted briefing replayed by tools/eval
    VOICE_PROMPT = "voice_prompt"  # question spoken by the voice prompter (kept for context)


class TranscriptSegment(Model):
    id: str = Field(default_factory=lambda: new_id("seg"))
    session_id: str
    seq: int = 0  # assigned by the orchestrator, monotonic per session
    speaker_id: str  # diarization label, e.g. "Guest-1", or a user id when known
    user_id: str | None = None  # crew member this speaker is linked to (via app sign-in + context)
    speaker_name: str | None = None
    text: str
    start_ms: int = 0
    end_ms: int = 0
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    is_final: bool = True
    language: str = "en-AU"
    source: SegmentSource = SegmentSource.AZURE_STT
    filtered: bool = False  # true = kept for audit but excluded from extraction
    filter_reason: str | None = None  # "low_confidence" | "off_topic" | "non_crew" | ...
    redacted: bool = False  # PII redaction applied
    received_at: datetime = Field(default_factory=utcnow)
