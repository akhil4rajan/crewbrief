"""Outputs of the conversation analyst and the hazard expert."""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import Field

from .common import EvidenceRef, Model, new_id
from .form import ControlStatus, HazardOrigin, HazardStatus
from .library import ControlType, Severity


class ObservationKind(StrEnum):
    JOB_DETAIL = "job_detail"  # attributes: {"field": "title"|"location"|"work_order_id"|...}
    TASK = "task"
    SITE_CONDITION = "site_condition"
    HAZARD = "hazard"
    CONTROL = "control"
    PPE = "ppe"
    EMERGENCY = "emergency"  # attributes: {"field": "muster_point"|"nearest_hospital"|...}
    PERMIT = "permit"
    ANSWER = "answer"  # answer to a voice-prompter question; attributes: {"gap_id": ...}


class Observation(Model):
    id: str = Field(default_factory=lambda: new_id("obs"))
    kind: ObservationKind
    text: str  # normalised statement, e.g. "Work within 3 m of live LV mains"
    code_hint: str | None = None  # library code if the analyst is confident
    negated: bool = False  # "there are no overhead lines here"
    speaker_id: str | None = None
    evidence: list[EvidenceRef] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    attributes: dict[str, Any] = Field(default_factory=dict)


class ControlRecommendation(Model):
    control_code: str
    name: str
    type: ControlType
    mentioned: bool = False  # crew actually said it (vs. retrieved from library)
    status: ControlStatus = ControlStatus.PROPOSED
    evidence: list[EvidenceRef] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    source_documents: list[str] = Field(default_factory=list)


class HazardAssessment(Model):
    hazard_code: str
    name: str
    category: str
    severity: Severity
    origin: HazardOrigin = HazardOrigin.MENTIONED
    status: HazardStatus = HazardStatus.PRESENT
    evidence: list[EvidenceRef] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    controls: list[ControlRecommendation] = Field(default_factory=list)
    source_documents: list[str] = Field(default_factory=list)
    observation_ids: list[str] = Field(default_factory=list)
