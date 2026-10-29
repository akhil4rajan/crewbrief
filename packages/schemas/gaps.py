from __future__ import annotations

import hashlib
from datetime import datetime
from enum import StrEnum

from pydantic import Field

from .common import Model, utcnow


class GapKind(StrEnum):
    UNSUPPORTED_FIELD = "unsupported_field"  # AI-filled field with no evidence
    HIGH_RISK_WITHOUT_CONTROL = "high_risk_without_control"  # no isolation/engineering control
    HAZARD_WITHOUT_CONTROL = "hazard_without_control"
    CONTRADICTION = "contradiction"
    MISSING_REQUIRED_FIELD = "missing_required_field"
    UNCONFIRMED_HAZARD = "unconfirmed_hazard"  # typical for the task but never discussed
    LOW_CONFIDENCE = "low_confidence"


class GapSeverity(StrEnum):
    BLOCKING = "blocking"  # sign-off needs a fix or an explicit override with justification
    WARNING = "warning"
    INFO = "info"


class GapStatus(StrEnum):
    OPEN = "open"
    RESOLVED = "resolved"
    DISMISSED = "dismissed"


class Gap(Model):
    id: str
    kind: GapKind
    severity: GapSeverity
    path: str  # JSON pointer into the form, e.g. "/hazards/HZ-ELEC-LV"
    message: str  # for the supervisor UI
    question: str | None = None  # short spoken question for the crew
    status: GapStatus = GapStatus.OPEN
    created_at: datetime = Field(default_factory=utcnow)
    resolved_at: datetime | None = None
    resolution: str | None = None  # how it was closed (answer, edit, dismissal reason)
    asked_at: datetime | None = None  # when the voice prompter asked the crew

    @staticmethod
    def stable_id(kind: GapKind | str, path: str) -> str:
        """Deterministic id so repeated verifier runs update rather than duplicate gaps."""
        digest = hashlib.sha1(f"{kind}|{path}".encode(), usedforsecurity=False).hexdigest()[:12]
        return f"gap_{digest}"
