"""Azure AI Speech **fast transcription** (REST, synchronous) for uploaded briefing recordings.

``POST {endpoint}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`` with a multipart
body: ``audio`` (the file) and ``definition`` (JSON: locale + diarization). The audio is sent from
memory and never written to disk (``RETAIN_RAW_AUDIO=false``). Each returned phrase becomes one
``TranscriptSegment`` whose speaker is the diarization label ``Guest-<n>``.

Auth: ``Ocp-Apim-Subscription-Key`` when ``AZURE_SPEECH_KEY`` is set, otherwise a Microsoft Entra
token from ``DefaultAzureCredential`` (requires a custom-domain ``AZURE_SPEECH_ENDPOINT``).
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from packages.common.config import Provider, Settings
from packages.common.errors import UpstreamError
from packages.schemas import SegmentSource, TranscriptSegment

from .base import TranscriberUnavailable

log = logging.getLogger(__name__)

API_VERSION = "2024-11-15"
TOKEN_SCOPE = "https://cognitiveservices.azure.com/.default"
MAX_SPEAKERS = 8
TIMEOUT_S = 300.0


def fast_transcription_url(settings: Settings) -> str:
    base = (settings.azure_speech_endpoint or
            f"https://{settings.azure_speech_region}.api.cognitive.microsoft.com").rstrip("/")
    return f"{base}/speechtotext/transcriptions:transcribe?api-version={API_VERSION}"


async def _auth_headers(settings: Settings) -> dict[str, str]:
    if not Settings.is_dummy(settings.azure_speech_key):
        return {"Ocp-Apim-Subscription-Key": settings.azure_speech_key.get_secret_value()}
    from azure.identity.aio import DefaultAzureCredential  # type: ignore[import-not-found]

    async with DefaultAzureCredential() as credential:
        token = await credential.get_token(TOKEN_SCOPE)
    return {"Authorization": f"Bearer {token.token}"}


def phrases_to_segments(session_id: str, body: dict[str, Any], language: str) -> list[TranscriptSegment]:
    segments = []
    for phrase in body.get("phrases") or []:
        text = str(phrase.get("text") or "").strip()
        if not text:
            continue
        start = int(phrase.get("offsetMilliseconds") or 0)
        speaker = phrase.get("speaker")
        segments.append(TranscriptSegment(
            session_id=session_id, speaker_id=f"Guest-{speaker}" if speaker is not None else "Unknown", text=text,
            start_ms=start, end_ms=start + int(phrase.get("durationMilliseconds") or 0),
            confidence=min(1.0, max(0.0, float(phrase.get("confidence", 1.0)))),
            language=str(phrase.get("locale") or language), source=SegmentSource.AZURE_STT))
    segments.sort(key=lambda s: s.start_ms)
    return segments


async def transcribe_recording(settings: Settings, session_id: str, audio: bytes, filename: str,
                               content_type: str) -> tuple[list[TranscriptSegment], int]:
    """Transcribe a whole recording with diarization. Returns (segments, duration_ms)."""
    if settings.provider("stt") != Provider.AZURE:
        raise TranscriberUnavailable("Recorded audio cannot be transcribed in local mode")
    definition = {"locales": [settings.speech_language],
                  "diarization": {"maxSpeakers": MAX_SPEAKERS, "enabled": True}}
    files = {"audio": (filename, audio, content_type),
             "definition": (None, json.dumps(definition), "application/json")}
    url = fast_transcription_url(settings)
    try:
        headers = await _auth_headers(settings)
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            resp = await client.post(url, files=files, headers=headers)
    except httpx.HTTPError as exc:
        raise UpstreamError(f"Azure AI Speech could not be reached ({type(exc).__name__})",
                            code="stt_unreachable") from exc
    except ImportError as exc:
        raise UpstreamError("Set AZURE_SPEECH_KEY, or install the azure extra for Microsoft Entra auth",
                            code="stt_auth_failed") from exc
    if resp.status_code in (401, 403):
        raise UpstreamError(
            f"Azure AI Speech refused the request (HTTP {resp.status_code}). Check AZURE_SPEECH_KEY, or for Entra "
            "auth use a custom-domain AZURE_SPEECH_ENDPOINT and give the identity 'Cognitive Services Speech User'",
            code="stt_auth_failed")
    if not resp.is_success:
        raise UpstreamError(f"Azure AI Speech fast transcription failed (HTTP {resp.status_code}): "
                            f"{resp.text[:300]}", code="stt_failed", extra={"upstream_status": resp.status_code})
    body = resp.json()
    segments = phrases_to_segments(session_id, body, settings.speech_language)
    duration_ms = int(body.get("durationMilliseconds") or (segments[-1].end_ms if segments else 0))
    log.info("fast_transcription_done", extra={"session_id": session_id, "segments": len(segments),
                                               "duration_ms": duration_ms, "bytes": len(audio)})
    return segments, duration_ms
