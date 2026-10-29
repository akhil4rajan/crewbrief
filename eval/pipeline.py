"""Offline, in-process replay of a briefing through the specialist roles.

Mirrors what the orchestrator does live, without any services running:

1. transcript lines become ``TranscriptSegment``s (the ASR hypothesis when the dataset simulates
   recognition errors; low-confidence segments are filtered like the transcription service does);
2. segments are grouped into extraction ticks every ``EXTRACTION_INTERVAL_SECONDS`` of audio, each
   window carrying a little overlap with the previous one;
3. per tick: conversation analyst -> hazard expert -> form filler, and the patches are applied with
   ``packages.rules.apply_patches`` exactly as the form API would;
4. the verifier runs every ``VERIFIER_EVERY_N_EXTRACTIONS`` ticks and once more at the end.

Roles are injected as a ``RoleName -> async handler`` mapping (``services.roles.registry.ROLE_HANDLERS``
by default), so the same replay scores local heuristics or Azure-backed roles.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from packages.rules import apply_patches
from packages.schemas import (
    ConversationAnalystRequest,
    CrewEntry,
    Form,
    FormFillerRequest,
    Gap,
    GapStatus,
    HazardAssessment,
    HazardExpertRequest,
    HazardLibrary,
    Observation,
    RoleMeta,
    RoleName,
    SegmentSource,
    TranscriptSegment,
    VerifierRequest,
    utcnow,
)

from .dataset import Briefing

logger = logging.getLogger(__name__)

RoleHandler = Callable[[Any], Awaitable[Any]]

RECENT_OBSERVATIONS = 30  # context handed back to the analyst, like the orchestrator's rolling memory


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


def extraction_windows(segments: list[TranscriptSegment], interval_ms: int, overlap: int
                       ) -> list[list[TranscriptSegment]]:
    """Group usable segments into ticks of ``interval_ms`` audio time, prefixing ``overlap`` segments
    from the previous tick so an utterance split across a boundary keeps its context."""
    usable = [s for s in segments if not s.filtered]
    windows: list[list[TranscriptSegment]] = []
    bucket: list[TranscriptSegment] = []
    boundary = interval_ms
    previous: list[TranscriptSegment] = []
    for seg in usable:
        while seg.end_ms > boundary:
            if bucket:
                windows.append(previous[-overlap:] + bucket if overlap else bucket)
                previous, bucket = bucket, []
            boundary += interval_ms
        bucket.append(seg)
    if bucket:
        windows.append(previous[-overlap:] + bucket if overlap else bucket)
    return windows


class OfflinePipeline:
    def __init__(self, handlers: Mapping[RoleName, RoleHandler], library: HazardLibrary, *,
                 interval_ms: int, verifier_every: int, min_confidence: float, overlap: int = 1) -> None:
        self._handlers = handlers
        self._library = library
        self._interval_ms = interval_ms
        self._verifier_every = max(1, verifier_every)
        self._min_confidence = min_confidence
        self._overlap = overlap

    async def run(self, briefing: Briefing) -> BriefingRun:
        started = time.perf_counter()
        session_id = f"eval_{briefing.id}"
        segments = build_segments(briefing, session_id, self._min_confidence)
        crew = [CrewEntry(user_id=c.user_id, name=c.name, role=c.role, checked_in_at=utcnow())
                for c in briefing.transcript.crew]
        run = BriefingRun(briefing_id=briefing.id, session_id=session_id, segments=segments,
                          form=Form(crew={c.user_id: c for c in crew}))

        windows = extraction_windows(segments, self._interval_ms, self._overlap)
        for tick, window in enumerate(windows, start=1):
            await self._extract(run, window, crew)
            run.ticks = tick
            if tick % self._verifier_every == 0 and tick != len(windows):
                await self._verify(run)
        await self._verify(run)  # end of briefing: final verifier pass before REVIEW
        run.wall_ms = (time.perf_counter() - started) * 1000
        return run

    async def _call(self, run: BriefingRun, role: RoleName, request: Any) -> Any | None:
        stats = run.role_stats.setdefault(role.value, RoleStats())
        stats.calls += 1
        started = time.perf_counter()
        try:
            response = await self._handlers[role](request)
        except Exception as exc:  # one failing role must not abort the whole evaluation
            stats.errors += 1
            run.errors.append(f"{role.value} tick {run.ticks + 1}: {type(exc).__name__}: {exc}")
            logger.warning("role failed during eval", extra={"role": role.value, "briefing": run.briefing_id},
                           exc_info=True)
            return None
        finally:
            stats.latency_ms += (time.perf_counter() - started) * 1000
        stats.meta = getattr(response, "meta", None) or stats.meta
        return response

    async def _extract(self, run: BriefingRun, window: list[TranscriptSegment], crew: list[CrewEntry]) -> None:
        open_gaps = [g for g in run.gaps if g.status == GapStatus.OPEN]
        analysis = await self._call(run, RoleName.CONVERSATION_ANALYST, ConversationAnalystRequest(
            session_id=run.session_id, window=window, crew=crew, open_gaps=open_gaps,
            recent_observations=run.observations[-RECENT_OBSERVATIONS:], task_type=run.task_type))
        if analysis is None:
            return
        run.dropped_segment_ids.update(analysis.dropped_segment_ids)
        run.observations.extend(analysis.observations)
        run.task_type = run.task_type or analysis.task_type_hint
        if not analysis.observations:
            return

        expert = await self._call(run, RoleName.HAZARD_EXPERT, HazardExpertRequest(
            session_id=run.session_id, observations=analysis.observations, task_type=run.task_type,
            existing_hazard_codes=list(run.form.hazards)))
        if expert is None:
            return
        run.task_type = expert.task_type or run.task_type
        for assessment in expert.assessments:
            run.assessments[assessment.hazard_code] = assessment

        filler = await self._call(run, RoleName.FORM_FILLER, FormFillerRequest(
            session_id=run.session_id, draft=run.form, observations=analysis.observations,
            assessments=expert.assessments))
        if filler is None:
            return
        run.form, applied, rejected = apply_patches(run.form, filler.patches, self._library)
        run.applied_patches += len(applied)
        run.rejected_patches.extend({"path": p.path, "rule": v.rule, "reason": v.message} for p, v in rejected)

    async def _verify(self, run: BriefingRun) -> None:
        response = await self._call(run, RoleName.VERIFIER, VerifierRequest(
            session_id=run.session_id, draft=run.form, transcript=run.segments, existing_gaps=run.gaps))
        if response is not None:
            run.gaps = response.gaps
