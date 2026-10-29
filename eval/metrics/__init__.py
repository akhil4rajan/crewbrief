"""Per-layer metrics. Each function returns ``({metric_key: Ratio}, details)`` for one briefing."""

from .base import Ratio, lower_is_better, pool
from .diarization import diarization_error_rate
from .form import evidence_metrics, field_metrics
from .hazards import hazard_metrics
from .speech import speech_metrics
from .text import DEFAULT_DOMAIN_TERMS, token_overlap, word_error_rates
from .verifier import filtering_metrics, seeded_gap_metrics

__all__ = [
    "DEFAULT_DOMAIN_TERMS",
    "Ratio",
    "diarization_error_rate",
    "evidence_metrics",
    "field_metrics",
    "filtering_metrics",
    "hazard_metrics",
    "lower_is_better",
    "pool",
    "seeded_gap_metrics",
    "speech_metrics",
    "token_overlap",
    "word_error_rates",
]
