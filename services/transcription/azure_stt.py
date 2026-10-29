"""Azure AI Speech ``ConversationTranscriber`` (real-time STT + speaker diarization).

The SDK is imported lazily so local mode never needs ``azure-cognitiveservices-speech``.
SDK callbacks fire on SDK-owned threads; results are marshalled back onto the gateway's
event loop with ``run_coroutine_threadsafe`` so ``on_segment`` runs in order, in-loop.
Audio is written to an in-memory push stream only (never to disk).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from packages.common.config import Settings
from packages.schemas import SegmentSource, TranscriptSegment

from .base import SegmentCallback, load_phrase_list

log = logging.getLogger(__name__)

TICKS_PER_MS = 10_000  # SDK offsets/durations are in 100 ns ticks
UNKNOWN_SPEAKER = "Unknown"


class AzureConversationTranscriber:
    def __init__(self, settings: Settings, *, sample_rate: int = 16000):
        self._settings = settings
        self._sample_rate = sample_rate
        self._loop: asyncio.AbstractEventLoop | None = None
        self._transcriber: Any = None
        self._stream: Any = None
        self._session_id = ""
        self._on_segment: SegmentCallback | None = None
        self._pending: set[Any] = set()

    def _speech_config(self) -> Any:
        import azure.cognitiveservices.speech as speechsdk  # type: ignore[import-not-found]

        s = self._settings
        if not Settings.is_dummy(s.azure_speech_key):
            config = speechsdk.SpeechConfig(subscription=s.azure_speech_key.get_secret_value(),
                                            region=s.azure_speech_region)
        else:
            from azure.identity import DefaultAzureCredential  # type: ignore[import-not-found]

            config = speechsdk.SpeechConfig(endpoint=s.azure_speech_endpoint,
                                            token_credential=DefaultAzureCredential())
        config.speech_recognition_language = s.speech_language
        config.output_format = speechsdk.OutputFormat.Detailed  # NBest with confidence
        if s.custom_speech_endpoint_id:
            config.endpoint_id = s.custom_speech_endpoint_id
        return config

    async def start(self, session_id: str, on_segment: SegmentCallback) -> None:
        import azure.cognitiveservices.speech as speechsdk  # type: ignore[import-not-found]

        self._loop = asyncio.get_running_loop()
        self._session_id = session_id
        self._on_segment = on_segment
        fmt = speechsdk.audio.AudioStreamFormat(samples_per_second=self._sample_rate, bits_per_sample=16,
                                                channels=1)
        self._stream = speechsdk.audio.PushAudioInputStream(stream_format=fmt)
        audio_config = speechsdk.audio.AudioConfig(stream=self._stream)
        self._transcriber = speechsdk.transcription.ConversationTranscriber(
            speech_config=self._speech_config(), audio_config=audio_config)

        phrases = speechsdk.PhraseListGrammar.from_recognizer(self._transcriber)
        for phrase in load_phrase_list():
            phrases.addPhrase(phrase)

        self._transcriber.transcribed.connect(self._on_transcribed)
        self._transcriber.canceled.connect(self._on_canceled)
        await asyncio.to_thread(lambda: self._transcriber.start_transcribing_async().get())
        log.info("stt_started", extra={"session_id": session_id, "language": self._settings.speech_language,
                                       "custom_endpoint": bool(self._settings.custom_speech_endpoint_id)})

    async def push_audio(self, chunk: bytes) -> None:
        if self._stream is not None and chunk:
            self._stream.write(chunk)

    async def stop(self) -> None:
        if self._transcriber is None:
            return
        self._stream.close()  # signals end-of-audio so the last utterance is finalised
        try:
            await asyncio.to_thread(lambda: self._transcriber.stop_transcribing_async().get())
        finally:
            self._transcriber = None
            # Let in-flight callbacks for the final results complete before returning.
            if self._pending:
                await asyncio.gather(*(asyncio.wrap_future(f) for f in list(self._pending)),
                                     return_exceptions=True)
        log.info("stt_stopped", extra={"session_id": self._session_id})

    # --- SDK thread callbacks -------------------------------------------------------------

    def _on_transcribed(self, evt: Any) -> None:
        import azure.cognitiveservices.speech as speechsdk  # type: ignore[import-not-found]

        result = evt.result
        if result.reason != speechsdk.ResultReason.RecognizedSpeech or not result.text:
            return
        segment = self._to_segment(result)
        if self._loop is None or self._on_segment is None:
            return
        fut = asyncio.run_coroutine_threadsafe(self._on_segment(segment), self._loop)
        self._pending.add(fut)
        fut.add_done_callback(self._pending.discard)

    def _on_canceled(self, evt: Any) -> None:
        details = getattr(evt, "cancellation_details", None) or getattr(evt.result, "cancellation_details", None)
        log.warning("stt_canceled", extra={"session_id": self._session_id,
                                           "reason": str(getattr(details, "reason", "")),
                                           "error": getattr(details, "error_details", "")})

    def _to_segment(self, result: Any) -> TranscriptSegment:
        start_ms = int(result.offset // TICKS_PER_MS)
        return TranscriptSegment(
            session_id=self._session_id,
            speaker_id=result.speaker_id or UNKNOWN_SPEAKER,
            text=result.text,
            start_ms=start_ms,
            end_ms=start_ms + int(result.duration // TICKS_PER_MS),
            confidence=_nbest_confidence(result.json),
            language=self._settings.speech_language,
            source=SegmentSource.AZURE_STT,
        )


def _nbest_confidence(raw_json: str | None) -> float:
    """Top NBest confidence from the detailed result; 1.0 when the service omits it."""
    if not raw_json:
        return 1.0
    try:
        nbest = json.loads(raw_json).get("NBest") or []
        conf = float(nbest[0].get("Confidence", 1.0)) if nbest else 1.0
    except (ValueError, TypeError, AttributeError, IndexError):
        return 1.0
    return min(1.0, max(0.0, conf))
