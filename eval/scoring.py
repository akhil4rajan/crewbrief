"""Score replayed briefings and check the result against the thresholds config."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from packages.schemas import HazardLibrary

from .dataset import Briefing
from .metrics import (
    Ratio,
    evidence_metrics,
    field_metrics,
    filtering_metrics,
    hazard_metrics,
    seeded_gap_metrics,
    speech_metrics,
)
from .pipeline import BriefingRun

DEFAULT_SEMANTIC_THRESHOLD = 0.5


@dataclass
class BriefingScore:
    briefing_id: str
    metrics: dict[str, Ratio]
    details: dict[str, Any]


def score_briefing(briefing: Briefing, run: BriefingRun, library: HazardLibrary, *,
                   domain_terms: Iterable[str], semantic_threshold: float) -> BriefingScore:
    metrics: dict[str, Ratio] = {}
    details: dict[str, Any] = {}

    m, d = speech_metrics(briefing, domain_terms)
    metrics |= m
    details |= d
    m, d = hazard_metrics(briefing, run, library)
    metrics |= m
    details |= d
    m, d = filtering_metrics(briefing, run)
    metrics |= m
    details |= d
    m, rows = field_metrics(briefing, run, semantic_threshold)
    metrics |= m
    details["field_mismatches"] = rows
    m, rows = evidence_metrics(briefing, run)
    metrics |= m
    details["evidence_problems"] = rows
    m, rows = seeded_gap_metrics(briefing, run)
    metrics |= m
    details["missed_seeded_gaps"] = rows
    details["open_gaps"] = [{"kind": g.kind.value, "severity": g.severity.value, "path": g.path}
                            for g in run.gaps if g.status.value == "open"]
    return BriefingScore(briefing.id, metrics, details)


@dataclass
class Check:
    metric: str
    op: str  # ">=" or "<="
    threshold: float
    value: float | None
    blocking: bool

    @property
    def passed(self) -> bool:
        """A gate with no data fails (an empty denominator must not pass CI); a target is just n/a."""
        if self.value is None:
            return not self.blocking
        return self.value >= self.threshold if self.op == ">=" else self.value <= self.threshold

    @property
    def status(self) -> str:
        if self.value is None:
            return "FAIL (no data)" if self.blocking else "n/a"
        return "PASS" if self.passed else ("FAIL" if self.blocking else "WARN")

    def to_json(self) -> dict[str, Any]:
        return {"metric": self.metric, "op": self.op, "threshold": self.threshold,
                "value": None if self.value is None else round(self.value, 4),
                "passed": self.passed, "status": self.status, "blocking": self.blocking}


@dataclass
class Thresholds:
    gates: dict[str, dict[str, float]]
    targets: dict[str, dict[str, float]]
    semantic_threshold: float = DEFAULT_SEMANTIC_THRESHOLD

    @classmethod
    def load(cls, path: Path | None) -> Thresholds:
        if path is None or not path.exists():
            return cls(gates={}, targets={})
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        settings = raw.get("settings") or {}
        return cls(gates=raw.get("gates") or {}, targets=raw.get("targets") or {},
                   semantic_threshold=float(settings.get("field_semantic_threshold", DEFAULT_SEMANTIC_THRESHOLD)))

    def check(self, aggregate: dict[str, Ratio]) -> list[Check]:
        checks: list[Check] = []
        for blocking, table in ((True, self.gates), (False, self.targets)):
            for metric, rule in table.items():
                value = aggregate[metric].value if metric in aggregate else None
                if "min" in rule:
                    checks.append(Check(metric, ">=", float(rule["min"]), value, blocking))
                if "max" in rule:
                    checks.append(Check(metric, "<=", float(rule["max"]), value, blocking))
        return checks
