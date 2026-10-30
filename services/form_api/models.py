"""Request/response models that only the form API exposes (shared payloads live in packages.schemas)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from packages.rules.risk import HazardRisk
from packages.schemas import (
    Clarification,
    Draft,
    Gap,
    Model,
    RecordingState,
    Session,
    SessionState,
    TranscriptSegment,
    User,
    utcnow,
)


class SessionDetail(Model):
    session: Session
    draft: Draft
    gaps: list[Gap]
    transcript_count: int
    risk: dict[str, HazardRisk] = Field(default_factory=dict)  # hazard code -> 5x5 matrix before/after controls


class SessionContext(Model):
    """Everything the orchestrator needs for one scheduling tick."""

    session: Session
    draft: Draft
    gaps: list[Gap]
    transcript: list[TranscriptSegment]


class DevTokenRequest(Model):
    user_id: str = Field(min_length=1, max_length=100)


class DevTokenResponse(Model):
    access_token: str
    token_type: str = "bearer"
    user: User


class CheckInRequest(Model):
    user_id: str | None = Field(default=None, max_length=100)


class DismissGapRequest(Model):
    reason: str = Field(min_length=1, max_length=500)


class SegmentsRequest(Model):
    segments: list[TranscriptSegment] = Field(max_length=500)


class SegmentsStored(Model):
    stored: int


class GapsRequest(Model):
    gaps: list[Gap] = Field(max_length=500)


class ClarificationsRequest(Model):
    clarifications: list[Clarification] = Field(max_length=10)


class SpeakerInfo(Model):
    speaker_id: str  # diarization label ("Guest-1") or whatever the device sent
    label: str  # "Speaker 1", by order of first appearance
    user_id: str | None = None
    name: str | None = None
    segment_count: int


class SpeakerUpdate(Model):
    user_id: str | None = Field(default=None, max_length=100)
    name: str | None = Field(default=None, min_length=1, max_length=100)


class RecordingRequest(Model):
    recording: RecordingState


class DiffChange(Model):
    path: str
    op: Literal["add", "remove", "replace"]
    before: Any = None
    after: Any = None
    role: str | None = None


class DiffResponse(Model):
    ai_revision: int
    final_revision: int
    changes: list[DiffChange]


class FieldEditRate(Model):
    path_pattern: str
    ai_filled: int
    edited: int
    edit_rate: float
    added_by_human: int = 0  # values the AI missed and a person added (a recall signal)


class RoleEditRate(Model):
    role: str  # the AI role that produced the value (provenance.role)
    ai_filled: int
    edited: int
    edit_rate: float


class EditRateResponse(Model):
    sessions: int
    fields: list[FieldEditRate]
    roles: list[RoleEditRate]


class Tombstone(Model):
    """What remains of a session after the retention deletion path has run."""

    session_id: str
    deleted_at: datetime = Field(default_factory=utcnow)
    deleted_by: str
    reason: str
    final_state: SessionState
    submission_ref: str | None = None
    purged: dict[str, int] = Field(default_factory=dict)
