"""Transcription (WER) and diarization (DER) metrics for one briefing.

Defaults come from ``transcript.json`` (``text`` vs ``asr_hypothesis``; true speaker vs
``hyp_speaker``); ``reference.txt``/``hypothesis.txt`` and ``diarization_*.json`` override them when a
recorded briefing has real STT output.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from ..dataset import Briefing, DiarizationTurn
from .base import Ratio
from .diarization import diarization_error_rate
from .text import word_error_rates


def speech_metrics(briefing: Briefing, domain_terms: Iterable[str]) -> tuple[dict[str, Ratio], dict[str, Any]]:
    lines = sorted(briefing.transcript.lines, key=lambda ln: ln.start_ms)
    reference = briefing.reference_text or "\n".join(ln.text for ln in lines)
    hypothesis = briefing.hypothesis_text or "\n".join(ln.heard for ln in lines)
    wer, domain_wer, domain_misses = word_error_rates(reference, hypothesis, domain_terms)

    ref_turns = briefing.diarization_ref or [
        DiarizationTurn(speaker=ln.user_id or ln.speaker, start_ms=ln.start_ms, end_ms=ln.end_ms) for ln in lines]
    hyp_turns = briefing.diarization_hyp or [
        DiarizationTurn(speaker=ln.heard_speaker, start_ms=ln.start_ms, end_ms=ln.end_ms) for ln in lines]
    der = diarization_error_rate(ref_turns, hyp_turns)
    return {
        "transcription.wer": wer,
        "transcription.domain_wer": domain_wer,
        "diarization.der": der,
    }, {"misrecognised_domain_terms": sorted(set(domain_misses))}
