"""Briefing session and its state machine.

    CREATED → BRIEFING → DRAFTING ⇄ GAP_CHECK → REVIEW → SIGNED → SUBMITTED
                                                     ↘ ABANDONED

The transition table lives here, in code, and is enforced by the form API (which owns
persisted state) and by the orchestrator (which drives the pre-REVIEW transitions).
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import Field

from .common import Model, new_id, utcnow


class SessionState(StrEnum):
    CREATED = "CREATED"
    BRIEFING = "BRIEFING"
    DRAFTING = "DRAFTING"
    GAP_CHECK = "GAP_CHECK"
    REVIEW = "REVIEW"
    SIGNED = "SIGNED"
    SUBMITTED = "SUBMITTED"
    ABANDONED = "ABANDONED"


S = SessionState

ALLOWED_TRANSITIONS: dict[SessionState, frozenset[SessionState]] = {
    S.CREATED: frozenset({S.BRIEFING, S.ABANDONED}),
    S.BRIEFING: frozenset({S.DRAFTING, S.GAP_CHECK, S.ABANDONED}),
    S.DRAFTING: frozenset({S.GAP_CHECK, S.ABANDONED}),
    S.GAP_CHECK: frozenset({S.DRAFTING, S.REVIEW, S.ABANDONED}),
    # A supervisor can send a draft back to the crew to keep briefing.
    S.REVIEW: frozenset({S.SIGNED, S.DRAFTING, S.ABANDONED}),
    S.SIGNED: frozenset({S.SUBMITTED}),
    S.SUBMITTED: frozenset(),
    S.ABANDONED: frozenset(),
}

TERMINAL_STATES = frozenset({S.SUBMITTED, S.ABANDONED})
LIVE_STATES = frozenset({S.BRIEFING, S.DRAFTING, S.GAP_CHECK})


class InvalidTransition(ValueError):
    def __init__(self, current: SessionState, target: SessionState):
        super().__init__(f"Cannot move session from {current} to {target}")
        self.current = current
        self.target = target


def can_transition(current: SessionState, target: SessionState) -> bool:
    return target in ALLOWED_TRANSITIONS[current]


def assert_transition(current: SessionState, target: SessionState) -> None:
    if not can_transition(current, target):
        raise InvalidTransition(current, target)


class RecordingState(StrEnum):
    IDLE = "idle"
    ACTIVE = "active"
    PAUSED = "paused"


class Session(Model):
    id: str = Field(default_factory=lambda: new_id("ses"))
    title: str
    state: SessionState = SessionState.CREATED
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    created_by: str
    supervisor_id: str | None = None
    crew_member_ids: list[str] = Field(default_factory=list)
    work_order_id: str | None = None
    task_type: str | None = None  # task type code
    location: str | None = None
    recording: RecordingState = RecordingState.IDLE
    consent_acknowledged_at: datetime | None = None
    signed_by: str | None = None
    signed_at: datetime | None = None
    sign_off_comment: str | None = None
    submitted_at: datetime | None = None
    submission_ref: str | None = None
    abandon_reason: str | None = None
    ai_draft_revision: int | None = None  # revision snapshotted when REVIEW was entered


class CreateSessionRequest(Model):
    title: str = Field(min_length=1, max_length=200)
    work_order_id: str | None = None
    task_type: str | None = None
    location: str | None = None
    supervisor_id: str | None = None
    crew_member_ids: list[str] = Field(default_factory=list)


class TransitionRequest(Model):
    to: SessionState
    reason: str | None = None


class SignOffRequest(Model):
    comment: str | None = Field(default=None, max_length=2000)
    # Blocking gaps may only be overridden with a written justification (audited).
    override_blocking_gaps: bool = False
    override_justification: str | None = Field(default=None, max_length=2000)


class AbandonRequest(Model):
    reason: str = Field(min_length=1, max_length=500)
