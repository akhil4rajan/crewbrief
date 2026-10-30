"""Realtime event envelope pushed to the crew device and the review portal.

Local mode: services POST envelopes to the gateway (``/internal/events``), which fans
them out over WebSocket. Azure mode: envelopes are sent to Azure Web PubSub group
``session.<session_id>``. Clients get the right URL from ``GET /api/sessions/{id}/negotiate``
on the gateway, so they never need to know which mode is running.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import Field

from .common import Model, new_id, utcnow


class EventType(StrEnum):
    SESSION_STATE_CHANGED = "session.state_changed"  # payload: {"from", "to", "reason"}
    SESSION_UPDATED = "session.updated"  # payload: Session
    RECORDING_CHANGED = "recording.changed"  # payload: {"recording": "active"|"paused"|"idle"}
    TRANSCRIPT_SEGMENT = "transcript.segment"  # payload: TranscriptSegment
    FORM_PATCHED = "form.patched"  # payload: {"revision", "patches": [FormPatch], "source"}
    FORM_SNAPSHOT = "form.snapshot"  # payload: Draft
    GAPS_UPDATED = "gaps.updated"  # payload: {"gaps": [Gap]}
    VOICE_PROMPT = "voice.prompt"  # payload: VoicePrompt
    # payload: {"role", "status": started|done|failed, "step", "tick", "summary", "provider", "model",
    #           "prompt_version", "latency_ms", "counts"} — one per role invocation (orchestrator)
    AGENT_ACTIVITY = "agent.activity"
    PRESENCE_UPDATED = "presence.updated"  # payload: {"crew": [CrewEntry]}
    ERROR = "error"  # payload: {"code", "message"}


class EventEnvelope(Model):
    id: str = Field(default_factory=lambda: new_id("evt"))
    type: EventType
    session_id: str
    ts: datetime = Field(default_factory=utcnow)
    payload: dict[str, Any] = Field(default_factory=dict)


def group_name(session_id: str) -> str:
    return f"session.{session_id}"
