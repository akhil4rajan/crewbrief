from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import Field

from .common import Model, new_id, utcnow


class ActorType(StrEnum):
    USER = "user"
    SERVICE = "service"
    SYSTEM = "system"


class AuditAction(StrEnum):
    SESSION_CREATED = "session.created"
    SESSION_TRANSITION = "session.transition"
    CREW_CHECKED_IN = "crew.checked_in"
    RECORDING_CHANGED = "recording.changed"
    SEGMENTS_RECEIVED = "transcript.segments_received"
    PATCH_APPLIED = "form.patch_applied"
    PATCH_REJECTED = "form.patch_rejected"
    HUMAN_EDIT = "form.human_edit"
    GAPS_UPDATED = "gaps.updated"
    GAP_DISMISSED = "gap.dismissed"
    VOICE_PROMPT = "voice.prompt"
    ROLE_INVOKED = "role.invoked"
    SIGNED_OFF = "session.signed_off"
    GAP_OVERRIDE = "session.gap_override"
    SUBMITTED = "session.submitted"
    ABANDONED = "session.abandoned"
    CONSENT_ACKNOWLEDGED = "session.consent_acknowledged"
    SESSION_DELETED = "session.deleted"  # retention deletion; the audit log itself is kept


class AuditEntry(Model):
    """Append-only. Every field records evidence, model + prompt version and reviewer action."""

    id: str = Field(default_factory=lambda: new_id("aud"))
    session_id: str
    ts: datetime = Field(default_factory=utcnow)
    actor_id: str
    actor_type: ActorType
    action: AuditAction
    path: str | None = None
    before: Any = None
    after: Any = None
    model: str | None = None
    prompt_version: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)
