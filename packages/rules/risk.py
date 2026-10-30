"""5x5 risk matrix (likelihood x consequence), in the AS/NZS ISO 31000 style used by Australian networks.

Deterministic and rules-in-code: the AI never scores risk.

Inherent ("before") risk comes from the hazard's library severity:

    severity   consequence  likelihood
    critical   5            3
    high       4            3
    medium     3            3
    low        2            2

Residual ("after") risk applies the single most effective *confirmed* control (status ``planned`` or
``in_place``; ``proposed`` library suggestions do not count), following the hierarchy of controls:

    elimination      hazard removed: likelihood and consequence drop to 1
    substitution     likelihood -2 and consequence -1
    isolation        likelihood -2
    engineering      likelihood -2
    administrative   likelihood -1
    ppe              consequence -1

Each factor is floored at 1. With no confirmed control, residual risk equals inherent risk.
Score = likelihood x consequence; level: 1-4 Low, 5-9 Medium, 10-16 High, 20-25 Extreme.
"""

from __future__ import annotations

from enum import StrEnum

from packages.schemas.common import Model
from packages.schemas.form import ControlStatus, Form, HazardEntry
from packages.schemas.library import ControlType, Severity


class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    EXTREME = "extreme"


class RiskScore(Model):
    likelihood: int  # 1 rare .. 5 almost certain
    consequence: int  # 1 insignificant .. 5 catastrophic
    score: int
    level: RiskLevel


class HazardRisk(Model):
    before: RiskScore
    after: RiskScore
    basis: str  # plain-language reason for the residual score


INHERENT: dict[Severity, tuple[int, int]] = {  # severity -> (likelihood, consequence)
    Severity.CRITICAL: (3, 5),
    Severity.HIGH: (3, 4),
    Severity.MEDIUM: (3, 3),
    Severity.LOW: (2, 2),
}

# control type -> (likelihood reduction, consequence reduction); elimination is handled as "to 1, 1".
REDUCTION: dict[ControlType, tuple[int, int]] = {
    ControlType.SUBSTITUTION: (2, 1),
    ControlType.ISOLATION: (2, 0),
    ControlType.ENGINEERING: (2, 0),
    ControlType.ADMINISTRATIVE: (1, 0),
    ControlType.PPE: (0, 1),
}

HIERARCHY = list(ControlType)  # most to least effective
CONFIRMED = (ControlStatus.PLANNED, ControlStatus.IN_PLACE)


def level_for(score: int) -> RiskLevel:
    if score >= 20:
        return RiskLevel.EXTREME
    if score >= 10:
        return RiskLevel.HIGH
    if score >= 5:
        return RiskLevel.MEDIUM
    return RiskLevel.LOW


def score(likelihood: int, consequence: int) -> RiskScore:
    likelihood = max(1, min(5, likelihood))
    consequence = max(1, min(5, consequence))
    s = likelihood * consequence
    return RiskScore(likelihood=likelihood, consequence=consequence, score=s, level=level_for(s))


def assess_hazard(hazard: HazardEntry) -> HazardRisk:
    likelihood, consequence = INHERENT[hazard.severity]
    before = score(likelihood, consequence)
    confirmed = [c for c in hazard.controls.values() if c.status in CONFIRMED]
    if not confirmed:
        return HazardRisk(before=before, after=before, basis="No confirmed control: residual risk equals inherent risk")
    best = min(confirmed, key=lambda c: HIERARCHY.index(c.type))
    if best.type == ControlType.ELIMINATION:
        after = score(1, 1)
    else:
        dl, dc = REDUCTION[best.type]
        after = score(likelihood - dl, consequence - dc)
    return HazardRisk(before=before, after=after, basis=f"Best confirmed control: {best.name} ({best.type.value})")


def assess_form(form: Form) -> dict[str, HazardRisk]:
    """Risk before and after controls for every hazard on the form, keyed by hazard code."""
    return {code: assess_hazard(h) for code, h in form.hazards.items()}
