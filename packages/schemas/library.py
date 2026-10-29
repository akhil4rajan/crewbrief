"""Company hazard & control library (the source of truth for codes).

The YAML at ``knowledge/sources/hazard_library.yaml`` is loaded into these models.
It is used by the hazard expert (retrieval), the rules engine (code mapping and the
high-risk control rule), the form API (pickers) and the eval harness.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import Field

from .common import Model

DEFAULT_LIBRARY_PATH = Path(__file__).resolve().parents[2] / "knowledge" / "sources" / "hazard_library.yaml"


class Severity(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"

    @property
    def weight(self) -> int:
        """Used for severity-weighted recall in eval."""
        return {"low": 1, "medium": 2, "high": 4, "critical": 8}[self.value]

    @property
    def is_high_risk(self) -> bool:
        return self in (Severity.HIGH, Severity.CRITICAL)


class ControlType(StrEnum):
    """Hierarchy of controls, most to least effective."""

    ELIMINATION = "elimination"
    SUBSTITUTION = "substitution"
    ISOLATION = "isolation"
    ENGINEERING = "engineering"
    ADMINISTRATIVE = "administrative"
    PPE = "ppe"

    @property
    def satisfies_high_risk_rule(self) -> bool:
        """A high-risk hazard needs at least one isolation or engineering control (or better)."""
        return self in (
            ControlType.ELIMINATION,
            ControlType.SUBSTITUTION,
            ControlType.ISOLATION,
            ControlType.ENGINEERING,
        )


class ControlDef(Model):
    code: str  # e.g. "CT-ISO-LOTO"
    name: str
    type: ControlType
    description: str = ""
    keywords: list[str] = Field(default_factory=list)


class HazardDef(Model):
    code: str  # e.g. "HZ-ELEC-LV"
    name: str
    category: str  # electrical, height, traffic, environmental, ...
    severity: Severity
    description: str = ""
    keywords: list[str] = Field(default_factory=list)
    typical_controls: list[str] = Field(default_factory=list)  # control codes
    references: list[str] = Field(default_factory=list)  # safety document ids


class TaskTypeDef(Model):
    code: str  # e.g. "TT-LV-CONNECT"
    name: str
    keywords: list[str] = Field(default_factory=list)
    typical_hazards: list[str] = Field(default_factory=list)  # hazard codes


class SiteConditionDef(Model):
    code: str  # e.g. "SC-WET"
    name: str
    keywords: list[str] = Field(default_factory=list)
    implies_hazards: list[str] = Field(default_factory=list)


class SafetyDocument(Model):
    id: str  # e.g. "DOC-ESR-001"
    title: str
    path: str  # relative to knowledge/sources
    hazard_codes: list[str] = Field(default_factory=list)
    control_codes: list[str] = Field(default_factory=list)


class HazardLibrary(Model):
    version: str
    hazards: list[HazardDef]
    controls: list[ControlDef]
    task_types: list[TaskTypeDef] = Field(default_factory=list)
    site_conditions: list[SiteConditionDef] = Field(default_factory=list)
    documents: list[SafetyDocument] = Field(default_factory=list)

    def hazard(self, code: str) -> HazardDef | None:
        return self._hazard_index().get(code)

    def control(self, code: str) -> ControlDef | None:
        return self._control_index().get(code)

    def task_type(self, code: str) -> TaskTypeDef | None:
        return next((t for t in self.task_types if t.code == code), None)

    def _hazard_index(self) -> dict[str, HazardDef]:
        return {h.code: h for h in self.hazards}

    def _control_index(self) -> dict[str, ControlDef]:
        return {c.code: c for c in self.controls}


def load_library(path: Path | str | None = None) -> HazardLibrary:
    raw = yaml.safe_load(Path(path or DEFAULT_LIBRARY_PATH).read_text(encoding="utf-8"))
    return HazardLibrary.model_validate(raw)


@lru_cache(maxsize=4)
def get_library(path: str | None = None) -> HazardLibrary:
    """Process-wide cached library. Pass a path to load an alternative library."""
    return load_library(path)
