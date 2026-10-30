"""Transcription library hosted in-process by the realtime gateway.

``build_transcriber`` returns the Azure ``ConversationTranscriber`` back-end in azure mode
and raises ``TranscriberUnavailable`` in local mode (audio cannot be transcribed offline;
devices fall back to sending on-device text).
"""

from __future__ import annotations

from packages.common.config import Provider, Settings, get_settings

from .base import SegmentCallback, Transcriber, TranscriberUnavailable, load_phrase_list
from .fast import transcribe_recording
from .filters import apply_filters, filter_reason
from .pii import PiiRedactor, RegexPiiRedactor, build_redactor, redact_segment, redact_text


def build_transcriber(settings: Settings | None = None, *, sample_rate: int = 16000) -> Transcriber:
    s = settings or get_settings()
    if s.provider("stt") != Provider.AZURE:
        raise TranscriberUnavailable("Speech-to-text is not available in local mode; send text transcripts")
    from .azure_stt import AzureConversationTranscriber

    return AzureConversationTranscriber(s, sample_rate=sample_rate)


__all__ = [
    "PiiRedactor", "RegexPiiRedactor", "SegmentCallback", "Transcriber", "TranscriberUnavailable",
    "apply_filters", "build_redactor", "build_transcriber", "filter_reason", "load_phrase_list",
    "redact_segment", "redact_text", "transcribe_recording",
]
