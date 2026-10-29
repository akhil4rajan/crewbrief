"""Offline, in-process replay of a briefing through the same extraction step the orchestrator runs.

Mirrors the live session runner without any services:

1. transcript lines become ``TranscriptSegment``s (the ASR hypothesis when the dataset simulates
   recognition errors; low-confidence segments are filtered like the transcription service does);
2. segments are released in extraction ticks every ``EXTRACTION_INTERVAL_SECONDS`` of audio time,
   each window prefixed with the runner's overlap segments;
3. each tick calls ``services.orchestrator.pipeline.run_extraction`` (analyst -> hazard expert ->
   form filler -> ``packages.rules.apply_patches``), so eval scores the production code path;
4. the verifier runs after every ``VERIFIER_EVERY_N_EXTRACTIONS`` extractions and once more at the end.

Roles are injected as a ``RoleName -> async handler`` mapping (``services.roles.registry.ROLE_HANDLERS``
by default), so the same replay scores local heuristics or Azure-backed roles.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from packages.schemas import (
    CrewEntry,
    Form,
    Gap,
    GapStatus,
    HazardAssessment,
    HazardLibrary,
    Model,
    Observation,
    RoleMeta,
    RoleName,
    SegmentSource,
    TranscriptSegment,
    VerifierRequest,
    VerifierResponse,
    utcnow,
)
from services.orchestrator.clients import RESPONSE_MODELS
from services.orchestrator.pipeline import RoleInvocationError, invoke_role, run_extraction
from services.orchestrator.runner import OVERLAP_SEGMENTS, RECENT_OBSERVATIONS

from .dataset import Briefing

logger = logging.getLogger(__name__)

RoleHandler = Callable[[Any], Awaitable[Any]]


@dataclass
class RoleStats:
    calls: int = 0
    errors: int = 0
    latency_ms: float = 0.0
    meta: RoleMeta | None = None  # last response meta (provider, model, prompt version)


@dataclass
class BriefingRun:
    """Everything the metrics need from one replayed briefing."""

    briefing_id: str
    session_id: str
    segments: list[TranscriptSegment]
    form: Form
    gaps: list[Gap] = field(default_factory=list)
    observations: list[Observation] = field(default_factory=list)
    assessments: dict[str, HazardAssessment] = field(default_factory=dict)  # latest per hazard code
    dropped_segment_ids: set[str] = field(default_factory=set)
    applied_patches: int = 0
    rejected_patches: list[dict[str, str]] = field(default_factory=list)  # {path, rule, reason}
    ticks: int = 0
    task_type: str | None = None
    role_stats: dict[str, RoleStats] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    wall_ms: float = 0.0

    def segment_id_for_line(self, line_id: str) -> str:
        return segment_id(self.briefing_id, line_id)


def segment_id(briefing_id: str, line_id: str) -> str:
    return f"seg_{briefing_id}_{line_id}"


class RecordingRolesClient:
    """In-process ``RolesClient`` that also records per-role calls, latency, errors and the hazard
    expert's assessments (which the form only partly reflects) for the current briefing."""

    def __init__(self, handlers: Mapping[RoleName, RoleHandler]) -> None:
        self._handlers = handlers
        self.run: BriefingRun | None = None

    async def invoke(self, role: RoleName, request: Model) -> Model:
        assert self.run is not None
        stats = self.run.role_stats.setdefault(role.value, RoleStats())
        stats.calls += 1
        started = time.perf_counter()
        try:
            raw = await self._handlers[role](request)
            response = raw if isinstance(raw, RESPONSE_MODELS[role]) else RESPONSE_MODELS[role].model_validate(raw)
        except Exception:
            stats.errors += 1
            raise
        finally:
            stats.latency_ms += (time.perf_counter() - started) * 1000
        stats.meta = response.meta  # type: ignore[attr-defined]
        if role == RoleName.HAZARD_EXPERT:
            for assessment in response.assessments:  # type: ignore[attr-defined]
                self.run.assessments[assessment.hazard_code] = assessment
        return response

    async def aclose(self) -> None:
        return None


def build_segments(briefing: Briefing, session_id: str, min_confidence: float) -> list[TranscriptSegment]:
    names = {c.user_id: c.name for c in briefing.transcript.crew}
    segments = []
    for seq, line in enumerate(sorted(briefing.transcript.lines, key=lambda ln: ln.start_ms), start=1):
        low = line.confidence < min_confidence
        segments.append(TranscriptSegment(
            id=segment_id(briefing.id, line.id), session_id=session_id, seq=seq,
            speaker_id=line.heard_speaker, user_id=line.user_id, speaker_name=names.get(line.user_id or ""),
            text=line.heard, start_ms=line.start_ms, end_ms=line.end_ms, confidence=line.confidence,
            source=SegmentSource.REPLAY, filtered=low, filter_reason="low_confidence" if low else None,
        ))
    return segments


def extraction_batches(segments: list[TranscriptSegment], interval_ms: int) -> list[list[TranscriptSegment]]:
    """New extractable segments available at each tick, i.e. finished within each interval of audio time."""
    batches: dict[int, list[TranscriptSegment]] = {}
    for seg in segments:
        if not seg.filtered:
            batches.setdefault(seg.end_ms // interval_ms, []).append(seg)
    return [batches[k] for k in sorted(batches)]


class OfflinePipeline:
    def __init__(self, handlers: Mapping[RoleName, RoleHandler], library: HazardLibrary, *,
                 interval_ms: int, verifier_every: int, min_confidence: float) -> None:
        self._roles = RecordingRolesClient(handlers)
        self._library = library
        self._interval_ms = interval_ms
        self._verifier_every = max(1, verifier_every)
        self._min_confidence = min_confidence

    async def run(self, briefing: Briefing) -> BriefingRun:
        started = time.perf_counter()
        session_id = f"eval_{briefing.id}"
        crew = [CrewEntry(user_id=c.user_id, name=c.name, role=c.role, checked_in_at=utcnow())
                for c in briefing.transcript.crew]
        run = BriefingRun(briefing_id=briefing.id, session_id=session_id,
                          segments=build_segments(briefing, session_id, self._min_confidence),
                          form=Form(crew={c.user_id: c for c in crew}))
        self._roles.run = run

        overlap: list[TranscriptSegment] = []
        recent: deque[Observation] = deque(maxlen=RECENT_OBSERVATIONS)
        since_verify = 0
        batches = extraction_batches(run.segments, self._interval_ms)
        for tick, batch in enumerate(batches, start=1):
            run.ticks = tick
            await self._extract(run, overlap + batch, crew, recent)
            overlap = (overlap + batch)[-OVERLAP_SEGMENTS:]
            since_verify += 1
            if since_verify >= self._verifier_every and tick != len(batches):
                await self._verify(run)
                since_verify = 0
        await self._verify(run)  # end of briefing: final verifier pass before REVIEW
        run.wall_ms = (time.perf_counter() - started) * 1000
        return run

    async def _extract(self, run: BriefingRun, window: list[TranscriptSegment], crew: list[CrewEntry],
                       recent: deque[Observation]) -> None:
        open_gaps = [g for g in run.gaps if g.status == GapStatus.OPEN]
        try:
            result = await run_extraction(self._roles, run.session_id, run.form, window, crew, open_gaps,
                                          list(recent), run.task_type, library=self._library)
        except RoleInvocationError as exc:  # the runner retries then skips the batch; eval records and moves on
            run.errors.append(f"tick {run.ticks}: {exc}")
            logger.warning("role failed during eval", extra={"briefing": run.briefing_id, "error": str(exc)})
            return
        run.form = result.form or run.form
        run.task_type = result.task_type or run.task_type
        run.observations.extend(result.observations)
        recent.extend(result.observations)
        run.dropped_segment_ids.update(result.dropped_segment_ids)
        run.applied_patches += len(result.patches)
        run.rejected_patches.extend({"path": p.path, "rule": v.rule, "reason": v.message} for p, v in result.rejected)

    async def _verify(self, run: BriefingRun) -> None:
        try:
            verdict = await invoke_role(self._roles, RoleName.VERIFIER, VerifierRequest(
                session_id=run.session_id, draft=run.form, transcript=run.segments, existing_gaps=run.gaps),
                VerifierResponse)
        except RoleInvocationError as exc:
            run.errors.append(f"verifier after tick {run.ticks}: {exc}")
            return
        run.gaps = verdict.gaps
