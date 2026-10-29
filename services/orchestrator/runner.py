"""Per-session deterministic state machine runner (not an LLM).

One ``SessionRunner`` per live briefing. It owns *scheduling*; the form API owns persisted
state. Timeline::

    segments ──► ingest: seq + speaker linking + store (form API)
    every EXTRACTION_INTERVAL_SECONDS, if new unfiltered segments and recording not paused:
        analyst → expert → filler → rules → form API patches       (BRIEFING→DRAFTING on first patch)
    every VERIFIER_EVERY_N_EXTRACTIONS extractions (milestone):
        DRAFTING→GAP_CHECK → verifier → PUT gaps → voice prompt (one, cooled down) → DRAFTING
    on end:
        final extraction → GAP_CHECK → verifier → PUT gaps → REVIEW (no voice prompt)

Ticks never overlap (one task + one lock per session). A failing tick is logged, audited
and retried with exponential backoff; a batch that keeps failing is eventually skipped so
one bad window can never wedge or kill the session.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from packages.common.config import Settings
from packages.common.errors import UpstreamError
from packages.common.events import EventPublisher
from packages.common.logging import session_id_var
from packages.schemas import (
    LIVE_STATES,
    TERMINAL_STATES,
    ActorType,
    ApplyPatchesRequest,
    AuditAction,
    AuditEntry,
    CrewEntry,
    EventEnvelope,
    EventType,
    Gap,
    GapKind,
    GapSeverity,
    GapStatus,
    HazardLibrary,
    Observation,
    RecordingState,
    RoleMeta,
    RoleName,
    SegmentSource,
    SessionState,
    TranscriptSegment,
    VerifierRequest,
    VerifierResponse,
    VoicePrompterRequest,
    VoicePrompterResponse,
    can_transition,
    get_library,
    utcnow,
)

from .clients import FormApi, RolesClient, SessionContext
from .pipeline import RoleInvocationError, invoke_role, run_extraction
from .speakers import SpeakerLinker

log = logging.getLogger(__name__)

ACTOR = "orchestrator"
OVERLAP_SEGMENTS = 2
RECENT_OBSERVATIONS = 30
MAX_SEEN_IDS = 10_000
MAX_BATCH_FAILURES = 4
MAX_BACKOFF_S = 60.0
VERIFY_TRANSCRIPT_LIMIT = 1000
VOICE_SPEAKER_ID = "crewbrief"

# Which gap the crew is asked about first. Lower is more urgent.
_SEVERITY_RANK = {GapSeverity.BLOCKING: 0, GapSeverity.WARNING: 1, GapSeverity.INFO: 2}
_KIND_RANK = {
    GapKind.HIGH_RISK_WITHOUT_CONTROL: 0, GapKind.UNCONFIRMED_HAZARD: 1, GapKind.CONTRADICTION: 2,
    GapKind.HAZARD_WITHOUT_CONTROL: 3, GapKind.MISSING_REQUIRED_FIELD: 4, GapKind.UNSUPPORTED_FIELD: 5,
    GapKind.LOW_CONFIDENCE: 6,
}


def _aware(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def gap_priority(gap: Gap) -> tuple[int, int, datetime]:
    return _SEVERITY_RANK[gap.severity], _KIND_RANK.get(gap.kind, 9), gap.created_at


@dataclass
class TickRecord:
    kind: str  # extraction | verify | final
    started_at: str
    duration_ms: int = 0
    segments: int = 0
    patches_applied: int = 0
    patches_rejected: int = 0
    open_gaps: int | None = None
    voice_prompt: str | None = None
    error: str | None = None


class SessionRunner:
    def __init__(self, session_id: str, *, form_api: FormApi, roles: RolesClient, publisher: EventPublisher,
                 settings: Settings, library: HazardLibrary | None = None):
        self.session_id = session_id
        self._form_api = form_api
        self._roles = roles
        self._publisher = publisher
        self._settings = settings
        self._library = library or get_library()

        self.state = SessionState.CREATED
        self.recording = RecordingState.IDLE
        self._seq = 0
        self._seen: dict[str, None] = {}  # insertion-ordered set, bounded
        self._pending: list[TranscriptSegment] = []
        self._overlap: list[TranscriptSegment] = []
        self._last_end_ms = 0
        self._recent_obs: deque[Observation] = deque(maxlen=RECENT_OBSERVATIONS)
        self._task_type: str | None = None
        self._linker = SpeakerLinker()
        self._asked: dict[str, datetime] = {}  # gap id → last time the crew was asked

        self._ingest_lock = asyncio.Lock()
        self._tick_lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._ending = False
        self._finalized = False
        self._settled = asyncio.Event()  # set when an end request has been fully handled
        self._failures = 0
        self._batch_failures = 0

        self.ticks = 0
        self.extractions = 0
        self.verifications = 0
        self.voice_prompts = 0
        self._extractions_at_last_verify = 0
        self.last: dict[str, TickRecord] = {}
        self.done_at: float | None = None

    # ------------------------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------------------------

    async def load(self) -> None:
        """Initialise from persisted state (first contact, or recovery after a restart)."""
        ctx = await self._form_api.context(self.session_id, transcript_limit=VERIFY_TRANSCRIPT_LIMIT)
        self.state = ctx.session.state
        self.recording = ctx.session.recording
        self._task_type = ctx.session.task_type
        self._linker.update_crew(self._crew(ctx))
        last_patch_at = ctx.draft.updated_at if ctx.draft.revision else None
        for seg in ctx.transcript:
            self._remember(seg.id)
            self._seq = max(self._seq, seg.seq)
            self._last_end_ms = max(self._last_end_ms, seg.end_ms)
            if seg.user_id:
                self._linker.remember(seg.speaker_id, seg.user_id)
            if self._extractable(seg) and (last_patch_at is None or _aware(seg.received_at) > _aware(last_patch_at)):
                self._pending.append(seg)
        # A crash mid-milestone leaves GAP_CHECK behind; carry on drafting.
        if self.state == SessionState.GAP_CHECK:
            await self._transition(SessionState.DRAFTING, "orchestrator recovered after restart")
        log.info("runner_loaded", extra={"session_id": self.session_id, "state": self.state,
                                         "seq": self._seq, "pending": len(self._pending)})

    def start(self) -> None:
        """Begin (or continue) scheduling. Idempotent."""
        if self.state in TERMINAL_STATES:
            return
        if self._task is None or self._task.done():
            self.done_at = None
            self._task = asyncio.create_task(self._loop(), name=f"runner-{self.session_id}")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def end(self, wait_s: float = 0.0) -> bool:
        """Final extraction + verifier, then REVIEW. Idempotent; the work runs on the runner task.

        Waits up to ``wait_s`` for it to finish and returns whether it did; on timeout it simply
        carries on in the background (clients see the REVIEW transition as an event).
        """
        if not (self._ending or self._finalized):
            self._ending = True
            self._settled.clear()
            self.start()
            self._wake.set()
        if wait_s > 0 and not self._settled.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._settled.wait(), timeout=wait_s)
        return self._settled.is_set()

    async def resume(self) -> None:
        """REVIEW → DRAFTING (supervisor sent the draft back) and restart scheduling."""
        async with self._tick_lock:
            ctx = await self._form_api.context(self.session_id, transcript_limit=1)
            self.state = ctx.session.state
            if self.state == SessionState.REVIEW:
                await self._transition(SessionState.DRAFTING, "briefing resumed")
            self._ending = False
            self._finalized = False
            self._extractions_at_last_verify = self.extractions
        self.start()

    async def set_recording(self, recording: RecordingState) -> None:
        session = await self._form_api.set_recording(self.session_id, recording)
        self.recording = session.recording
        if recording == RecordingState.ACTIVE:
            self._wake.set()

    # ------------------------------------------------------------------------------------
    # Ingest
    # ------------------------------------------------------------------------------------

    async def ingest(self, segments: list[TranscriptSegment]) -> int:
        """Assign seq, link speakers, store. De-duplicates by segment id (gateway retries)."""
        async with self._ingest_lock:
            fresh: list[TranscriptSegment] = []
            ids: set[str] = set()
            seq = self._seq
            for seg in segments:
                if seg.id in self._seen or seg.id in ids:
                    continue
                ids.add(seg.id)
                seq += 1
                linked = self._linker.link(seg)
                fresh.append(linked.model_copy(update={"seq": seq, "session_id": self.session_id}))
            if not fresh:
                return 0
            await self._form_api.store_segments(self.session_id, fresh)
            # Commit only after the store succeeded, so a retried batch is not lost as a duplicate.
            self._seq = seq
            for seg in fresh:
                self._remember(seg.id)
                self._last_end_ms = max(self._last_end_ms, seg.end_ms)
                if self._extractable(seg):
                    self._pending.append(seg)
            return len(fresh)

    @staticmethod
    def _extractable(seg: TranscriptSegment) -> bool:
        return not seg.filtered and seg.source != SegmentSource.VOICE_PROMPT

    def _remember(self, segment_id: str) -> None:
        self._seen[segment_id] = None
        if len(self._seen) > MAX_SEEN_IDS:
            self._seen.pop(next(iter(self._seen)))

    # ------------------------------------------------------------------------------------
    # Scheduling loop
    # ------------------------------------------------------------------------------------

    def _delay(self) -> float:
        base = self._settings.extraction_interval_seconds
        if self._failures:
            return min(MAX_BACKOFF_S, base * 2 ** min(self._failures, 6))
        return 0.0 if self._ending else base

    async def _loop(self) -> None:
        session_id_var.set(self.session_id)
        log.info("runner_started", extra={"session_id": self.session_id})
        try:
            while True:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), timeout=self._delay())
                self._wake.clear()
                try:
                    if self._ending:
                        await self._finalize()
                        return
                    if self.state in TERMINAL_STATES or self.state == SessionState.REVIEW:
                        return
                    if self.recording == RecordingState.PAUSED or not self._pending:
                        continue
                    await self._tick()
                    self._failures = 0
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - one bad tick must never kill the session
                    self._failures += 1
                    log.exception("tick_failed", extra={"session_id": self.session_id, "failures": self._failures,
                                                        "retry_in_s": self._delay(), "error": str(exc)})
        finally:
            self.done_at = time.monotonic()
            log.info("runner_stopped", extra={"session_id": self.session_id, "state": self.state})

    async def _tick(self) -> None:
        async with self._tick_lock:
            self.ticks += 1
            ctx = await self._refresh(transcript_limit=1)
            if self.state not in LIVE_STATES:
                return
            await self._extract(ctx)
            due = self.extractions - self._extractions_at_last_verify >= self._settings.verifier_every_n_extractions
            if due and self.state == SessionState.DRAFTING:
                await self._verify(live=True)

    async def _finalize(self) -> None:
        async with self._tick_lock:
            ctx = await self._refresh(transcript_limit=1)
            if self.state not in LIVE_STATES:
                log.info("end_ignored", extra={"session_id": self.session_id, "state": self.state})
                self._ending = False
                self._finalized = self.state == SessionState.REVIEW
                self._settled.set()
                return
            while self._pending:  # each pass consumes its batch or raises (retried with backoff)
                await self._extract(ctx, kind="final")
            await self._verify(live=False)
            await self._transition(SessionState.REVIEW, "briefing ended")
            if self.recording != RecordingState.IDLE:
                with contextlib.suppress(UpstreamError):
                    await self.set_recording(RecordingState.IDLE)
            self._ending = False
            self._finalized = True
            self._settled.set()
            log.info("briefing_finalized", extra={"session_id": self.session_id, "ticks": self.ticks,
                                                  "extractions": self.extractions})

    # ------------------------------------------------------------------------------------
    # Steps
    # ------------------------------------------------------------------------------------

    async def _refresh(self, transcript_limit: int) -> SessionContext:
        ctx = await self._form_api.context(self.session_id, transcript_limit=transcript_limit)
        self.state = ctx.session.state
        self.recording = ctx.session.recording
        self._linker.update_crew(self._crew(ctx))
        return ctx

    @staticmethod
    def _crew(ctx: SessionContext) -> list[CrewEntry]:
        crew = list(ctx.draft.form.crew.values())
        known = {c.user_id for c in crew}
        crew += [CrewEntry(user_id=uid, name=uid) for uid in ctx.session.crew_member_ids if uid not in known]
        return crew

    async def _extract(self, ctx: SessionContext, kind: str = "extraction") -> None:
        batch = list(self._pending)
        record = TickRecord(kind=kind, started_at=utcnow().isoformat(), segments=len(batch))
        started = time.perf_counter()
        try:
            form = ctx.draft.form
            task_type = self._task_type or ctx.session.task_type or (
                form.job.task_type.value if form.job.task_type else None)
            open_gaps = [g for g in ctx.gaps if g.status == GapStatus.OPEN]
            try:
                result = await run_extraction(
                    self._roles, self.session_id, form, self._overlap + batch, self._crew(ctx), open_gaps,
                    list(self._recent_obs), task_type, library=self._library)
            except RoleInvocationError as exc:
                await self._audit_roles(exc.metas, kind)
                await self._audit_role_failure(exc)
                self._batch_failures += 1
                if self._batch_failures >= MAX_BATCH_FAILURES:
                    log.error("extraction_batch_skipped", extra={"session_id": self.session_id,
                                                                 "segments": [s.id for s in batch]})
                    self._consume(batch)
                raise
            await self._audit_roles(result.metas, kind, rejected_by_rules=len(result.rejected))
            record.patches_rejected = len(result.rejected)
            if result.patches:
                applied = await self._form_api.apply_patches(self.session_id,
                                                             ApplyPatchesRequest(patches=result.patches))
                record.patches_applied = len(applied.applied)
                record.patches_rejected += len(applied.rejected)
                if applied.applied and self.state == SessionState.BRIEFING:
                    await self._transition(SessionState.DRAFTING, "first form update")
            self._consume(batch)
            self._recent_obs.extend(result.observations)
            self._task_type = result.task_type or task_type
            self.extractions += 1
        except Exception as exc:
            record.error = f"{type(exc).__name__}: {exc}"[:500]
            raise
        finally:
            record.duration_ms = int((time.perf_counter() - started) * 1000)
            self.last[kind] = record
        log.info("extraction_done", extra={"session_id": self.session_id, "segments": len(batch),
                                           "patches_applied": record.patches_applied,
                                           "patches_rejected": record.patches_rejected,
                                           "duration_ms": record.duration_ms})

    def _consume(self, batch: list[TranscriptSegment]) -> None:
        done = {s.id for s in batch}
        self._pending = [s for s in self._pending if s.id not in done]
        self._overlap = (self._overlap + batch)[-OVERLAP_SEGMENTS:]
        self._batch_failures = 0

    async def _verify(self, *, live: bool) -> None:
        """Milestone verifier. ``live`` = briefing still running (voice prompts allowed, back to DRAFTING)."""
        kind = "verify" if live else "final_verify"
        record = TickRecord(kind=kind, started_at=utcnow().isoformat())
        started = time.perf_counter()
        self._extractions_at_last_verify = self.extractions
        try:
            if self.state != SessionState.GAP_CHECK:
                await self._transition(SessionState.GAP_CHECK, "milestone verification" if live else "briefing ended")
            ctx = await self._form_api.context(self.session_id, transcript_limit=VERIFY_TRANSCRIPT_LIMIT)
            try:
                verdict = await invoke_role(self._roles, RoleName.VERIFIER, VerifierRequest(
                    session_id=self.session_id, draft=ctx.draft.form, transcript=ctx.transcript,
                    existing_gaps=ctx.gaps), VerifierResponse)
            except RoleInvocationError as exc:
                await self._audit_role_failure(exc)
                raise
            await self._audit_roles([verdict.meta], kind)
            gaps = await self._form_api.put_gaps(self.session_id, verdict.gaps)
            record.open_gaps = sum(g.status == GapStatus.OPEN for g in gaps)
            self.verifications += 1
            if live:
                record.voice_prompt = await self._maybe_prompt(gaps)
        except Exception as exc:
            record.error = f"{type(exc).__name__}: {exc}"[:500]
            raise
        finally:
            if live and self.state == SessionState.GAP_CHECK:
                with contextlib.suppress(Exception):
                    await self._transition(SessionState.DRAFTING, "verification done")
            record.duration_ms = int((time.perf_counter() - started) * 1000)
            self.last[kind] = record
        log.info("verification_done", extra={"session_id": self.session_id, "open_gaps": record.open_gaps,
                                             "voice_prompt": record.voice_prompt, "duration_ms": record.duration_ms})

    def _already_asked(self, gap: Gap) -> bool:
        return gap.asked_at is not None or gap.id in self._asked

    def _in_cooldown(self) -> bool:
        if not self._asked:
            return False
        last = max(self._asked.values())
        return (utcnow() - last).total_seconds() < self._settings.voice_prompt_cooldown_seconds

    async def _maybe_prompt(self, gaps: list[Gap]) -> str | None:
        """Ask the crew about the most urgent open gap not yet asked.

        Each gap is asked once per briefing (unanswered ones stay on the supervisor's list), and
        questions are spaced by the cooldown so the crew is never talked over.
        """
        if self._in_cooldown():
            return None
        candidates = [g for g in gaps if g.status == GapStatus.OPEN
                      and g.severity in (GapSeverity.BLOCKING, GapSeverity.WARNING) and not self._already_asked(g)]
        if not candidates:
            return None
        gap = min(candidates, key=gap_priority)
        try:
            response = await invoke_role(self._roles, RoleName.VOICE_PROMPTER, VoicePrompterRequest(
                session_id=self.session_id, gaps=[gap],
                already_asked_gap_ids=sorted(k for k in self._asked if k != gap.id), max_prompts=1,
            ), VoicePrompterResponse)
        except RoleInvocationError as exc:
            await self._audit_role_failure(exc)
            return None  # a missed question is retried at the next milestone
        await self._audit_roles([response.meta], "voice_prompt")
        if not response.prompts:
            return None
        prompt = response.prompts[0]
        now = utcnow()
        self._asked[prompt.gap_id] = now
        self.voice_prompts += 1
        await self._publisher.publish(EventEnvelope(type=EventType.VOICE_PROMPT, session_id=self.session_id,
                                                    payload=prompt.model_dump(mode="json")))
        # Keep the question in the transcript for context; filtered so it is never extracted as crew speech.
        await self.ingest([TranscriptSegment(
            session_id=self.session_id, speaker_id=VOICE_SPEAKER_ID, speaker_name="CrewBrief", text=prompt.text,
            start_ms=self._last_end_ms, end_ms=self._last_end_ms, source=SegmentSource.VOICE_PROMPT,
            filtered=True, filter_reason="voice_prompt", language=self._settings.speech_language)])
        await self._form_api.audit(self.session_id, AuditEntry(
            session_id=self.session_id, actor_id=ACTOR, actor_type=ActorType.SERVICE, action=AuditAction.VOICE_PROMPT,
            path=gap.path, after=prompt.text, model=response.meta.model, prompt_version=response.meta.prompt_version,
            details={"gap_id": prompt.gap_id, "gap_kind": gap.kind.value, "severity": gap.severity.value,
                     "has_audio": prompt.audio_b64 is not None}))
        if prompt.gap_id == gap.id:
            await self._form_api.put_gaps(self.session_id, [
                g.model_copy(update={"asked_at": now}) if g.id == gap.id else g for g in gaps])
        return prompt.text

    async def _transition(self, to: SessionState, reason: str) -> None:
        if self.state == to:
            return
        if not can_transition(self.state, to):
            log.warning("transition_skipped", extra={"session_id": self.session_id, "from": self.state, "to": to})
            return
        session = await self._form_api.transition(self.session_id, to, reason)
        log.info("state_transition", extra={"session_id": self.session_id, "from": self.state, "to": session.state,
                                            "reason": reason})
        self.state = session.state

    # ------------------------------------------------------------------------------------
    # Audit
    # ------------------------------------------------------------------------------------

    async def _audit_roles(self, metas: list[RoleMeta], step: str, **details: Any) -> None:
        entries = [AuditEntry(
            session_id=self.session_id, actor_id=ACTOR, actor_type=ActorType.SERVICE, action=AuditAction.ROLE_INVOKED,
            model=m.model, prompt_version=m.prompt_version,
            details={"role": m.role, "provider": m.provider, "latency_ms": m.latency_ms, "tokens_in": m.tokens_in,
                     "tokens_out": m.tokens_out, "step": step, "tick": self.ticks, **details},
        ) for m in metas]
        await asyncio.gather(*(self._form_api.audit(self.session_id, e) for e in entries))

    async def _audit_role_failure(self, exc: RoleInvocationError) -> None:
        await self._form_api.audit(self.session_id, AuditEntry(
            session_id=self.session_id, actor_id=ACTOR, actor_type=ActorType.SERVICE, action=AuditAction.ROLE_INVOKED,
            details={"role": exc.role.value, "error": str(exc)[:500], "latency_ms": exc.latency_ms,
                     "tick": self.ticks}))

    # ------------------------------------------------------------------------------------
    # Ops
    # ------------------------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id, "state": self.state, "recording": self.recording,
            "running": self.running, "ending": self._ending, "finalized": self._finalized,
            "seq": self._seq, "pending_segments": len(self._pending), "ticks": self.ticks,
            "extractions": self.extractions, "verifications": self.verifications,
            "voice_prompts": self.voice_prompts, "consecutive_failures": self._failures,
            "task_type": self._task_type, "speaker_links": self._linker.labels,
            "last": {k: asdict(v) for k, v in self.last.items()},
        }
