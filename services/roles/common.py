"""Shared plumbing for the roles: library and search access, role metadata, provenance."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from functools import lru_cache

from packages.common.config import get_settings
from packages.prompts import Prompt, load_prompt
from packages.schemas import EvidenceRef, HazardLibrary, Provenance, RoleMeta, Source, TranscriptSegment, get_library

HEURISTIC_MODEL = "heuristic-v1"
PROVIDER_HEURISTIC = "heuristic"
PROVIDER_AZURE_OPENAI = "azure-openai"
SERVICE_NAME = "roles"
MAX_QUOTE_CHARS = 300


def library() -> HazardLibrary:
    s = get_settings()
    return get_library(str(s.hazard_library_path) if s.hazard_library_path else None)


@lru_cache(maxsize=8)
def prompt(role: str) -> Prompt:
    return load_prompt(role)


@dataclass
class RoleRun:
    """Times one role invocation and builds its ``RoleMeta``."""

    role: str
    provider: str = PROVIDER_HEURISTIC
    model: str = HEURISTIC_MODEL
    tokens_in: int | None = None
    tokens_out: int | None = None
    started: float = field(default_factory=time.perf_counter)

    @property
    def prompt_version(self) -> str:
        return prompt(self.role).version_id

    def add_usage(self, tokens_in: int | None, tokens_out: int | None) -> None:
        if tokens_in is not None:
            self.tokens_in = (self.tokens_in or 0) + tokens_in
        if tokens_out is not None:
            self.tokens_out = (self.tokens_out or 0) + tokens_out

    def meta(self) -> RoleMeta:
        return RoleMeta(role=self.role, provider=self.provider, model=self.model,
                        prompt_version=self.prompt_version,
                        latency_ms=int((time.perf_counter() - self.started) * 1000),
                        tokens_in=self.tokens_in, tokens_out=self.tokens_out)

    def provenance(self, evidence: list[EvidenceRef], confidence: float) -> Provenance:
        return Provenance(source=Source.AI, role=self.role, model=self.model, prompt_version=self.prompt_version,
                          evidence=evidence, confidence=round(max(0.0, min(1.0, confidence)), 3),
                          updated_by=SERVICE_NAME)


def evidence_for(segment: TranscriptSegment, quote: str | None = None) -> EvidenceRef:
    return EvidenceRef(segment_id=segment.id, speaker_id=segment.user_id or segment.speaker_id,
                       start_ms=segment.start_ms, end_ms=segment.end_ms,
                       quote=(quote if quote is not None else segment.text)[:MAX_QUOTE_CHARS])


def merge_evidence(*groups: list[EvidenceRef]) -> list[EvidenceRef]:
    seen: set[tuple[str, str]] = set()
    out: list[EvidenceRef] = []
    for group in groups:
        for ev in group:
            key = (ev.segment_id, ev.quote)
            if key not in seen:
                seen.add(key)
                out.append(ev)
    return out
