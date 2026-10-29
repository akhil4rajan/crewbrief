"""Metric values that pool correctly across briefings.

Every metric is a ratio kept as (numerator, denominator), so the dataset aggregate is the pooled
(micro-averaged) value rather than a mean of per-briefing rates, which would let a short briefing
count as much as a long one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Ratio:
    num: float = 0.0
    den: float = 0.0

    @property
    def value(self) -> float | None:
        return self.num / self.den if self.den else None

    def __add__(self, other: Ratio) -> Ratio:
        return Ratio(self.num + other.num, self.den + other.den)

    def to_json(self) -> dict[str, Any]:
        value = self.value
        return {"value": None if value is None else round(value, 4), "num": round(self.num, 4),
                "den": round(self.den, 4)}


# Metrics where a lower value is better (used for display and for picking the gate direction).
LOWER_IS_BETTER = {"wer", "domain_wer", "der", "hallucination_rate", "false_drop_rate", "noise_evidence_rate"}


def lower_is_better(key: str) -> bool:
    return key.rsplit(".", 1)[-1] in LOWER_IS_BETTER


def pool(results: list[dict[str, Ratio]]) -> dict[str, Ratio]:
    out: dict[str, Ratio] = {}
    for result in results:
        for key, ratio in result.items():
            out[key] = out.get(key, Ratio()) + ratio
    return out
