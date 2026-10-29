"""Pick the most important unanswered gaps and phrase them as short questions.

Local mode returns text only (the device does TTS). Azure mode also synthesises audio with Azure AI
Speech neural TTS (``VOICE_NAME``, 24 kHz WAV, base64). A Voice Live API realtime session
(``VOICE_LIVE_ENDPOINT``, instructions in ``packages/prompts/voice_prompter``) can sit behind this
same interface to speak and listen conversationally; it is not needed for one-shot questions, so
the synthesiser below is the default implementation.
"""

from __future__ import annotations

import asyncio
import base64
import logging

from packages.common.config import Settings, get_settings
from packages.schemas import (
    GapKind,
    GapSeverity,
    GapStatus,
    VoicePrompt,
    VoicePrompterRequest,
    VoicePrompterResponse,
)

from ..common import RoleRun, library
from ..questions import gap_question, trim

log = logging.getLogger(__name__)
ROLE = "voice_prompter"
AUDIO_FORMAT = "audio/wav;rate=24000"
_SEVERITY = {GapSeverity.BLOCKING: 100, GapSeverity.WARNING: 50, GapSeverity.INFO: 0}
# Crew-answerable gaps only; unsupported/low-confidence fields are for the supervisor's review.
_KIND = {GapKind.HIGH_RISK_WITHOUT_CONTROL: 30, GapKind.CONTRADICTION: 25, GapKind.UNCONFIRMED_HAZARD: 20,
         GapKind.HAZARD_WITHOUT_CONTROL: 15, GapKind.MISSING_REQUIRED_FIELD: 10}


def select_prompts(req: VoicePrompterRequest) -> list[VoicePrompt]:
    lib = library()
    asked = set(req.already_asked_gap_ids)
    candidates: list[VoicePrompt] = []
    for gap in req.gaps:
        if gap.status != GapStatus.OPEN or gap.id in asked or gap.asked_at is not None or gap.kind not in _KIND \
                or gap.severity == GapSeverity.INFO:
            continue
        text = gap.question or gap_question(gap.kind, gap.path, lib)
        if text:
            parts = gap.path.strip("/").split("/")
            hazard = lib.hazard(parts[1]) if parts[0] == "hazards" and len(parts) > 1 else None
            priority = _SEVERITY[gap.severity] + _KIND[gap.kind] + (hazard.severity.weight if hazard else 0)
            candidates.append(VoicePrompt(gap_id=gap.id, text=trim(text), priority=priority))
    candidates.sort(key=lambda p: (-p.priority, p.gap_id))
    return candidates[:max(req.max_prompts, 0)]


async def prompt_local(req: VoicePrompterRequest) -> VoicePrompterResponse:
    run = RoleRun(ROLE, provider="template", model="template-v1")
    return VoicePrompterResponse(prompts=select_prompts(req), meta=run.meta())


def _synthesise(text: str, settings: Settings) -> bytes:
    import azure.cognitiveservices.speech as speechsdk

    if not Settings.is_dummy(settings.azure_speech_key):
        cfg = speechsdk.SpeechConfig(subscription=settings.azure_speech_key.get_secret_value(),
                                     region=settings.azure_speech_region)
    else:
        from azure.identity import DefaultAzureCredential

        cfg = speechsdk.SpeechConfig(endpoint=settings.azure_speech_endpoint, token_credential=DefaultAzureCredential())
    cfg.speech_synthesis_voice_name = settings.voice_name
    cfg.set_speech_synthesis_output_format(speechsdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm)
    result = speechsdk.SpeechSynthesizer(speech_config=cfg, audio_config=None).speak_text_async(text).get()
    if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
        raise RuntimeError(f"TTS failed: {result.reason}")
    return bytes(result.audio_data)


async def prompt_azure(req: VoicePrompterRequest) -> VoicePrompterResponse:
    settings = get_settings()
    run = RoleRun(ROLE, provider="azure-speech", model=settings.voice_name)
    prompts = select_prompts(req)
    for p in prompts:
        try:
            audio = await asyncio.wait_for(asyncio.to_thread(_synthesise, p.text, settings),
                                           timeout=settings.llm_timeout_seconds)
            p.audio_b64, p.audio_format = base64.b64encode(audio).decode("ascii"), AUDIO_FORMAT
        except Exception as exc:  # noqa: BLE001 - degrade to on-device TTS of the text
            log.warning("tts_failed", extra={"gap_id": p.gap_id, "error": str(exc)})
    return VoicePrompterResponse(prompts=prompts, meta=run.meta())

