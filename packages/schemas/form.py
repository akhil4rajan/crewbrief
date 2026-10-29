"""The JSA / SWMS draft form.

Collections are dicts keyed by a stable id (hazard code, control code, task id...) so that
JSON-Pointer patches such as ``/hazards/HZ-ELEC-LV/controls/CT-ISO-LOTO`` stay valid while
the crew, the AI and the supervisor edit concurrently. Keys must not contain ``/`` or ``~``.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import Field

from .common import Model, Provenance
from .library import ControlType, Severity

FORM_SCHEMA_VERSION = "jsa/1.0"


class FieldValue(Model):
    """A scalar form field plus its provenance."""

    value: Any = None
    provenance: Provenance = Field(default_factory=Provenance)


class HazardStatus(StrEnum):
    PRESENT = "present"
    UNCONFIRMED = "unconfirmed"  # suggested (e.g. typical for the task) but not discussed yet
    NOT_PRESENT = "not_present"  # only with explicit evidence or a human decision


class HazardOrigin(StrEnum):
    MENTIONED = "mentioned"  # crew talked about it
    TASK_TYPICAL = "task_typical"  # hazard expert added it as typical for the task type
    SITE_CONDITION = "site_condition"  # implied by a site condition
    HUMAN = "human"  # added by a person in the UI


class ControlStatus(StrEnum):
    PLANNED = "planned"  # crew said they will do it
    IN_PLACE = "in_place"  # crew said it is done
    PROPOSED = "proposed"  # suggested from the library, not confirmed by the crew


class JobDetails(Model):
    title: FieldValue | None = None
    work_order_id: FieldValue | None = None
    task_type: FieldValue | None = None  # value = task type code
    location: FieldValue | None = None  # value = free-text address / asset id
    description: FieldValue | None = None
    scheduled_start: FieldValue | None = None


class CrewEntry(Model):
    user_id: str
    name: str
    role: str = "crew"  # crew | leading_hand | supervisor | contractor
    checked_in_at: datetime | None = None
    acknowledged: bool = False  # crew member acknowledged the final form


class TaskStep(Model):
    id: str  # "T1", "T2", ...
    order: int
    description: str
    provenance: Provenance = Field(default_factory=Provenance)


class SiteCondition(Model):
    id: str  # library code (SC-WET) or slug
    code: str | None = None
    description: str
    provenance: Provenance = Field(default_factory=Provenance)


class ControlEntry(Model):
    code: str  # library control code; human-added customs use "CT-CUSTOM-<slug>"
    name: str
    type: ControlType
    status: ControlStatus = ControlStatus.PROPOSED
    description: str = ""
    provenance: Provenance = Field(default_factory=Provenance)


class HazardEntry(Model):
    code: str  # library hazard code; human-added customs use "HZ-CUSTOM-<slug>"
    name: str
    category: str
    severity: Severity
    status: HazardStatus = HazardStatus.UNCONFIRMED
    origin: HazardOrigin = HazardOrigin.MENTIONED
    description: str = ""
    controls: dict[str, ControlEntry] = Field(default_factory=dict)
    provenance: Provenance = Field(default_factory=Provenance)


class PpeItem(Model):
    code: str  # library control code of type ppe
    name: str
    provenance: Provenance = Field(default_factory=Provenance)


class EmergencyPlan(Model):
    muster_point: FieldValue | None = None
    nearest_hospital: FieldValue | None = None
    first_aider: FieldValue | None = None
    communications: FieldValue | None = None


class Permit(Model):
    id: str
    type: str  # e.g. "access_permit", "switching_instruction", "vegetation_permit"
    reference: str = ""
    provenance: Provenance = Field(default_factory=Provenance)


class Form(Model):
    schema_version: str = FORM_SCHEMA_VERSION
    job: JobDetails = Field(default_factory=JobDetails)
    crew: dict[str, CrewEntry] = Field(default_factory=dict)
    tasks: dict[str, TaskStep] = Field(default_factory=dict)
    site_conditions: dict[str, SiteCondition] = Field(default_factory=dict)
    hazards: dict[str, HazardEntry] = Field(default_factory=dict)
    ppe: dict[str, PpeItem] = Field(default_factory=dict)
    emergency: EmergencyPlan = Field(default_factory=EmergencyPlan)
    permits: dict[str, Permit] = Field(default_factory=dict)
    notes: FieldValue | None = None


class Draft(Model):
    """A form plus its optimistic-concurrency revision."""

    session_id: str
    revision: int = 0
    form: Form = Field(default_factory=Form)
    updated_at: datetime | None = None
