"""Primitives shared by every contract: evidence, provenance, ids, time."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id(prefix: str) -> str:
    """Readable, sortable-enough ids, e.g. ``ses_3f9c2a1b7d4e``."""
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Model(BaseModel):
    """Base model: strict about unknown fields so contract drift fails loudly."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, use_enum_values=False)


class Source(StrEnum):
    AI = "ai"
    HUMAN = "human"
    SYSTEM = "system"


class EvidenceRef(Model):
    """A pointer to the transcript span that supports a field."""

    segment_id: str
    speaker_id: str | None = None
    start_ms: int = 0
    end_ms: int = 0
    quote: str = Field(default="", max_length=1000)


class Provenance(Model):
    """Who/what produced a value and why we believe it. Required on every form field."""

    source: Source = Source.AI
    role: str | None = None  # e.g. "form_filler", "supervisor"
    model: str | None = None  # model deployment name, or "heuristic-v1" in local mode
    prompt_version: str | None = None
    evidence: list[EvidenceRef] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    updated_by: str | None = None  # user id or service name
    updated_at: datetime = Field(default_factory=utcnow)

    @property
    def has_evidence(self) -> bool:
        return any(e.segment_id for e in self.evidence)


class RoleMeta(Model):
    """Attached to every role response, recorded in the audit log."""

    role: str
    provider: str  # "azure-openai" | "heuristic"
    model: str
    prompt_version: str
    latency_ms: int = 0
    tokens_in: int | None = None
    tokens_out: int | None = None
