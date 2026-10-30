"""Domain logic of the form API.

Every mutation of a session (its state, draft, gaps) runs under a per-session ``asyncio.Lock``
so concurrent AI patches, human edits and transitions are applied one at a time in this
process. Across replicas, the repository's conditional draft write (``expected_revision``)
is the guard: a lost race surfaces as HTTP 409 rather than a silent overwrite.

Events are emitted only after the write they describe has committed.
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from packages.common.errors import AppError, Conflict, Forbidden, NotFound, UnprocessableEntity, UpstreamError
from packages.rules import apply_patches, can_sign_off, evaluate_draft, is_crew_lead
from packages.schemas import (
    LIVE_STATES,
    TERMINAL_STATES,
    AbandonRequest,
    ActorType,
    ApplyPatchesRequest,
    ApplyPatchesResult,
    AuditAction,
    AuditEntry,
    Clarification,
    ClarificationStatus,
    CreateSessionRequest,
    CrewEntry,
    Draft,
    EventType,
    FieldValue,
    Form,
    FormPatch,
    Gap,
    GapSeverity,
    GapStatus,
    HazardLibrary,
    JobDetails,
    PatchOp,
    Provenance,
    RecordingState,
    RejectedPatch,
    SegmentSource,
    Session,
    SessionState,
    SignOffRequest,
    Source,
    SpeakerAssignment,
    TranscriptSegment,
    TransitionRequest,
    User,
    UserRole,
    assert_transition,
    is_diarized_speaker,
    speaker_label,
    utcnow,
)

from . import analytics
from .directory import UserDirectory
from .downstream import OrchestratorClient, SubmissionAdapter
from .events import EventBus
from .gaps import RULE_GAP_KINDS, gaps_from_rules, merge_gaps
from .models import (
    DiffResponse,
    EditRateResponse,
    SessionContext,
    SessionDetail,
    SpeakerInfo,
    SpeakerUpdate,
    Tombstone,
)
from .store import Repository, RevisionConflict

log = logging.getLogger(__name__)

S = SessionState
PRE_REVIEW = frozenset({S.CREATED, S.BRIEFING, S.DRAFTING, S.GAP_CHECK})
SUPERVISOR_EDITABLE = PRE_REVIEW | {S.REVIEW}
LEAD_EDITABLE = SUPERVISOR_EDITABLE  # the crew lead reviews and fixes the draft until it is signed
SEGMENT_STATES = LIVE_STATES | {S.REVIEW}  # late segments after end-briefing are still kept
SCALAR_FIELD_SECTIONS = ("job", "emergency")
SERVICE_NAME = "form_api"


class Gone(AppError):
    status_code = 410
    code = "session_deleted"


@dataclass(frozen=True)
class Actor:
    id: str
    type: ActorType
    role: str | None = None

    @classmethod
    def of(cls, user: User) -> Actor:
        return cls(user.id, ActorType.USER, primary_role(user))

    @classmethod
    def service(cls, name: str) -> Actor:
        return cls(name, ActorType.SERVICE, name)

    @classmethod
    def system(cls) -> Actor:
        return cls(SERVICE_NAME, ActorType.SYSTEM, SERVICE_NAME)


def primary_role(user: User) -> str:
    for role in (UserRole.SUPERVISOR, UserRole.SAFETY_ADMIN, UserRole.CREW, UserRole.SERVICE):
        if role in user.roles:
            return role.value
    return "unknown"


def _crew_only(user: User) -> bool:
    return not user.has_role(UserRole.SUPERVISOR, UserRole.SAFETY_ADMIN)


def _ensure_lead_or_admin(user: User, session: Session, what: str) -> None:
    """Review actions: the crew lead (session creator), or a supervisor/safety admin."""
    if not (is_crew_lead(user, session) or user.has_role(UserRole.SUPERVISOR, UserRole.SAFETY_ADMIN)):
        raise Forbidden(f"Only the crew lead who started this briefing can {what}")


def _unescape(part: str) -> str:
    return part.replace("~1", "/").replace("~0", "~")


def _value_at(form: Form, path: str) -> Any:
    node: Any = form.model_dump(mode="json")
    for part in path.split("/")[1:]:
        if not isinstance(node, dict):
            return None
        node = node.get(_unescape(part))
    return node


def _dump(models: Iterable[Any]) -> list[dict[str, Any]]:
    return [m.model_dump(mode="json") for m in models]


class FormService:
    def __init__(self, *, repo: Repository, events: EventBus, directory: UserDirectory, library: HazardLibrary,
                 orchestrator: OrchestratorClient, submitter: SubmissionAdapter):
        self.repo = repo
        self.directory = directory
        self.library = library
        self._events = events
        self._orchestrator = orchestrator
        self._submitter = submitter
        self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()

    # ------------------------------------------------------------------ plumbing

    def _lock(self, session_id: str) -> asyncio.Lock:
        lock = self._locks.get(session_id)
        if lock is None:
            lock = self._locks[session_id] = asyncio.Lock()
        return lock

    async def get_session(self, session_id: str) -> Session:
        session = await self.repo.get_session(session_id)
        if session is None:
            if await self.repo.get_tombstone(session_id):
                raise Gone(f"Session {session_id} was deleted under the retention policy")
            raise NotFound(f"Session {session_id} not found")
        return session

    async def get_draft(self, session_id: str) -> Draft:
        await self.get_session(session_id)
        return await self._load_draft(session_id)

    async def _load_draft(self, session_id: str) -> Draft:
        draft = await self.repo.get_draft(session_id)
        if draft is None:
            raise NotFound(f"Draft for session {session_id} not found")
        return draft

    async def _audit(self, session_id: str, actor: Actor, action: AuditAction, **fields: Any) -> None:
        await self.repo.append_audit([self._entry(session_id, actor, action, **fields)])

    @staticmethod
    def _entry(session_id: str, actor: Actor, action: AuditAction, **fields: Any) -> AuditEntry:
        return AuditEntry(session_id=session_id, actor_id=actor.id, actor_type=actor.type, action=action, **fields)

    def _emit_session(self, session: Session) -> None:
        self._events.emit(EventType.SESSION_UPDATED, session.id, session.model_dump(mode="json"))

    def _emit_gaps(self, session_id: str, gaps: list[Gap]) -> None:
        self._events.emit(EventType.GAPS_UPDATED, session_id, {"gaps": _dump(gaps)})

    async def ensure_viewer(self, user: User, session_id: str) -> None:
        """Audit log and AI-vs-final are visible to the crew on the job, supervisors and admins."""
        self._ensure_participant(user, await self.get_session(session_id))

    @staticmethod
    def _ensure_participant(user: User, session: Session) -> None:
        """Crew may only act on briefings they are part of; supervisors and admins on any."""
        if _crew_only(user) and user.id not in session.crew_member_ids and user.id != session.created_by:
            raise Forbidden("You are not on this briefing's crew")

    async def _save_draft(self, draft: Draft, form: Form, *, source: str, actor_id: str) -> Draft:
        new = Draft(session_id=draft.session_id, revision=draft.revision + 1, form=form, updated_at=utcnow())
        try:
            await self.repo.save_draft(new, expected_revision=draft.revision, source=source, actor_id=actor_id)
        except RevisionConflict as exc:
            raise Conflict(str(exc), code="revision_conflict", extra={"current_revision": exc.actual}) from exc
        return new

    async def _transition(self, session: Session, to: SessionState, actor: Actor, reason: str | None, *,
                          action: AuditAction = AuditAction.SESSION_TRANSITION,
                          updates: dict[str, Any] | None = None, details: dict[str, Any] | None = None) -> Session:
        """Caller holds the session lock. Same-state requests are no-ops (idempotent retries)."""
        if session.state == to:
            return session
        frm = session.state
        assert_transition(frm, to)
        changes: dict[str, Any] = {"state": to, "updated_at": utcnow(), **(updates or {})}
        if to == S.REVIEW:
            changes["ai_draft_revision"] = (await self._load_draft(session.id)).revision
            if any(c.status == ClarificationStatus.OPEN for c in session.clarifications):
                # Unanswered questions stay as open gaps for the reviewer.
                changes["clarifications"] = [
                    c.model_copy(update={"status": ClarificationStatus.SKIPPED})
                    if c.status == ClarificationStatus.OPEN else c for c in session.clarifications]
        recording_stopped = to not in LIVE_STATES and session.recording != RecordingState.IDLE
        if recording_stopped:
            changes["recording"] = RecordingState.IDLE
        new = session.model_copy(update=changes)
        await self.repo.put_session(new)
        await self._audit(session.id, actor, action, before=frm.value, after=to.value,
                          details={"reason": reason, **(details or {})})
        log.info("session_transition", extra={"session_id": session.id, "from": frm.value, "to": to.value,
                                              "actor": actor.id, "reason": reason})
        self._events.emit(EventType.SESSION_STATE_CHANGED, session.id,
                          {"from": frm.value, "to": to.value, "reason": reason})
        if recording_stopped:
            self._events.emit(EventType.RECORDING_CHANGED, session.id, {"recording": RecordingState.IDLE.value})
        self._emit_session(new)
        return new

    # ------------------------------------------------------------------ read models

    async def detail(self, session_id: str) -> SessionDetail:
        session = await self.get_session(session_id)
        return SessionDetail(session=session, draft=await self._load_draft(session_id),
                             gaps=await self.repo.list_gaps(session_id),
                             transcript_count=await self.repo.count_segments(session_id))

    async def context(self, session_id: str, transcript_limit: int) -> SessionContext:
        session = await self.get_session(session_id)
        return SessionContext(session=session, draft=await self._load_draft(session_id),
                              gaps=await self.repo.list_gaps(session_id),
                              transcript=await self.repo.list_segments(session_id, limit=transcript_limit))

    async def list_sessions(self, *, states: list[SessionState] | None, member_id: str | None,
                            limit: int) -> list[Session]:
        return await self.repo.list_sessions(states=states, member_id=member_id, limit=limit)

    async def transcript(self, session_id: str, limit: int | None) -> list[TranscriptSegment]:
        await self.get_session(session_id)
        return await self.repo.list_segments(session_id, limit=limit)

    async def gaps(self, session_id: str) -> list[Gap]:
        await self.get_session(session_id)
        return await self.repo.list_gaps(session_id)

    async def audit_log(self, session_id: str) -> list[AuditEntry]:
        # Still readable after a retention deletion: that is what the tombstone is for.
        if await self.repo.get_session(session_id) is None and await self.repo.get_tombstone(session_id) is None:
            raise NotFound(f"Session {session_id} not found")
        return await self.repo.list_audit(session_id)

    # ------------------------------------------------------------------ lifecycle (public)

    async def create_session(self, user: User, req: CreateSessionRequest) -> SessionDetail:
        crew_ids = list(dict.fromkeys(req.crew_member_ids))
        if user.has_role(UserRole.CREW) and user.id not in crew_ids:
            crew_ids.insert(0, user.id)  # the crew member starting the briefing leads it and is on it
        crew: dict[str, CrewEntry] = {}
        now = utcnow()
        for uid in crew_ids:
            member = self.directory.get(uid) or (user if uid == user.id else None)
            if member is None:
                raise UnprocessableEntity(f"Unknown crew member {uid}", code="unknown_user")
            crew[uid] = (CrewEntry(user_id=uid, name=member.name, role="leading_hand", checked_in_at=now)
                         if uid == user.id else CrewEntry(user_id=uid, name=member.name))
        supervisor_id = req.supervisor_id or (
            user.id if user.has_role(UserRole.SUPERVISOR) and user.id not in crew else None)
        if supervisor_id:
            sup = self.directory.get(supervisor_id) or (user if supervisor_id == user.id else None)
            if sup is None or not sup.has_role(UserRole.SUPERVISOR):
                raise UnprocessableEntity(f"{supervisor_id} is not a supervisor", code="invalid_supervisor")
            if supervisor_id in crew:
                raise UnprocessableEntity("The supervisor cannot also be on the crew", code="invalid_supervisor")
        if req.task_type and self.library.task_type(req.task_type) is None:
            raise UnprocessableEntity(f"Unknown task type {req.task_type}", code="unknown_task_type")

        session = Session(title=req.title, created_by=user.id, supervisor_id=supervisor_id, crew_member_ids=crew_ids,
                          work_order_id=req.work_order_id, task_type=req.task_type, location=req.location)
        prov = self._human_provenance(user)

        def field(value: str | None) -> FieldValue | None:
            return FieldValue(value=value, provenance=prov) if value else None

        job = JobDetails(title=field(req.title), work_order_id=field(req.work_order_id),
                         task_type=field(req.task_type), location=field(req.location))
        draft = Draft(session_id=session.id, form=Form(job=job, crew=crew), updated_at=utcnow())
        await self.repo.insert_session(session, draft, actor_id=user.id)
        await self._audit(session.id, Actor.of(user), AuditAction.SESSION_CREATED,
                          after={"title": req.title, "crew_member_ids": crew_ids, "supervisor_id": supervisor_id,
                                 "work_order_id": req.work_order_id, "task_type": req.task_type})
        log.info("session_created", extra={"session_id": session.id, "created_by": user.id})
        return await self.detail(session.id)

    async def check_in(self, user: User, session_id: str, target_id: str | None) -> SessionDetail:
        target_id = target_id or user.id
        member = self.directory.get(target_id) or (user if target_id == user.id else None)
        if member is None:
            raise UnprocessableEntity(f"Unknown user {target_id}", code="unknown_user")
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            if target_id != user.id:
                self._ensure_participant(user, session)
            if session.state not in SUPERVISOR_EDITABLE:
                raise Conflict(f"Cannot check in to a session in {session.state}", code="invalid_state")
            draft = await self._load_draft(session_id)
            form = draft.form.model_copy(deep=True)
            entry = form.crew.get(target_id) or CrewEntry(user_id=target_id, name=member.name)
            entry = entry.model_copy(update={"checked_in_at": utcnow()})
            form.crew[target_id] = entry
            draft = await self._save_draft(draft, form, source=Source.SYSTEM.value, actor_id=user.id)
            if target_id not in session.crew_member_ids:
                session = session.model_copy(update={"crew_member_ids": [*session.crew_member_ids, target_id],
                                                     "updated_at": utcnow()})
                await self.repo.put_session(session)
                self._emit_session(session)
            await self._audit(session_id, Actor.of(user), AuditAction.CREW_CHECKED_IN, path=f"/crew/{target_id}",
                              after=entry.model_dump(mode="json"))
            patch = FormPatch(op=PatchOp.ADD, path=f"/crew/{target_id}", value=entry.model_dump(mode="json"),
                              provenance=Provenance(source=Source.SYSTEM, updated_by=user.id, confidence=1.0))
            self._events.emit(EventType.FORM_PATCHED, session_id, {"revision": draft.revision,
                                                                   "patches": _dump([patch]), "source": "system"})
            self._events.emit(EventType.PRESENCE_UPDATED, session_id, {"crew": _dump(form.crew.values())})
        return await self.detail(session_id)

    async def acknowledge_form(self, user: User, session_id: str) -> SessionDetail:
        """A crew member confirms they have read the final form. Allowed in REVIEW and after sign-off."""
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            if session.state not in (S.REVIEW, S.SIGNED, S.SUBMITTED):
                raise Conflict(f"Cannot acknowledge a form in {session.state}", code="invalid_state")
            draft = await self._load_draft(session_id)
            entry = draft.form.crew.get(user.id)
            if entry is None:
                raise Forbidden("Only crew members on this job can acknowledge the form")
            if not entry.acknowledged:
                form = draft.form.model_copy(deep=True)
                entry = entry.model_copy(update={"acknowledged": True})
                form.crew[user.id] = entry
                draft = await self._save_draft(draft, form, source=Source.SYSTEM.value, actor_id=user.id)
                await self._audit(session_id, Actor.of(user), AuditAction.CREW_ACKNOWLEDGED, path=f"/crew/{user.id}",
                                  after=True)
                patch = FormPatch(op=PatchOp.REPLACE, path=f"/crew/{user.id}", value=entry.model_dump(mode="json"),
                                  provenance=Provenance(source=Source.SYSTEM, updated_by=user.id, confidence=1.0))
                self._events.emit(EventType.FORM_PATCHED, session_id, {"revision": draft.revision,
                                                                       "patches": _dump([patch]), "source": "system"})
                self._events.emit(EventType.PRESENCE_UPDATED, session_id, {"crew": _dump(form.crew.values())})
        return await self.detail(session_id)

    async def acknowledge_consent(self, user: User, session_id: str) -> Session:
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            self._ensure_participant(user, session)
            if session.consent_acknowledged_at is None:
                now = utcnow()
                session = session.model_copy(update={"consent_acknowledged_at": now, "updated_at": now})
                await self.repo.put_session(session)
                await self._audit(session_id, Actor.of(user), AuditAction.CONSENT_ACKNOWLEDGED, after=now.isoformat())
                self._emit_session(session)
        return session

    async def start(self, user: User, session_id: str) -> Session:
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            self._ensure_participant(user, session)
            if session.consent_acknowledged_at is None:
                # Crews must be told recording is active before it starts (workplace surveillance law).
                raise Conflict("Recording consent must be acknowledged before the briefing starts",
                               code="consent_required")
            session = await self._transition(session, S.BRIEFING, Actor.of(user), "briefing started")
        # Outside the lock: the orchestrator calls back into /internal/* for this session.
        await self._orchestrator.start(session_id)
        return session

    async def end_briefing(self, user: User, session_id: str) -> Session:
        session = await self.get_session(session_id)
        self._ensure_participant(user, session)
        if session.state == S.REVIEW:
            return session
        if session.state not in LIVE_STATES:
            raise Conflict(f"Cannot end a briefing in {session.state}", code="invalid_state")
        if session.state == S.GAP_CHECK and any(c.status == ClarificationStatus.OPEN for c in session.clarifications):
            return session  # already ended; the clarification round is running
        reached = await self._orchestrator.end(session_id)
        session = await self.get_session(session_id)
        if not reached and session.state in LIVE_STATES:
            # Never dead-end the crew: run the code rules here and move on to review.
            log.warning("orchestrator_unavailable_local_end_briefing", extra={"session_id": session_id})
            session = await self._finish_locally(session_id)
        return session

    async def _finish_locally(self, session_id: str, reason: str = "orchestrator unavailable; rules evaluated locally"
                              ) -> Session:
        actor = Actor.system()
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            if session.state not in LIVE_STATES:
                return session
            session = await self._transition(session, S.GAP_CHECK, actor, reason)
            draft = await self._load_draft(session_id)
            await self._refresh_rule_gaps(session_id, draft.form, actor)
            return await self._transition(session, S.REVIEW, actor, reason)

    async def finish_clarifications(self, user: User, session_id: str) -> Session:
        """Crew tapped "Done": GAP_CHECK → REVIEW; unanswered questions are marked skipped."""
        session = await self.get_session(session_id)
        self._ensure_participant(user, session)
        if session.state == S.REVIEW:
            return session
        if session.state != S.GAP_CHECK:
            raise Conflict(f"There is no clarification round in {session.state}", code="invalid_state")
        reached = await self._orchestrator.finish(session_id)
        session = await self.get_session(session_id)
        if session.state == S.GAP_CHECK:
            if reached:
                log.warning("orchestrator_did_not_finish", extra={"session_id": session_id})
            session = await self._finish_locally(session_id, reason="clarifications finished by crew")
        return session

    async def put_clarifications(self, session_id: str, clarifications: list[Clarification]) -> Session:
        """Internal (orchestrator): replace the clarification round's questions and statuses."""
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            if session.clarifications == clarifications:
                return session
            if session.state not in LIVE_STATES:
                raise Conflict(f"Clarifications cannot change in {session.state}", code="invalid_state")
            session = session.model_copy(update={"clarifications": clarifications, "updated_at": utcnow()})
            await self.repo.put_session(session)
            await self._audit(session_id, Actor.service("orchestrator"), AuditAction.CLARIFICATIONS_UPDATED,
                              after=_dump(clarifications))
            self._emit_session(session)
            return session

    async def resume_briefing(self, user: User, session_id: str) -> Session:
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            _ensure_lead_or_admin(user, session, "send the briefing back")
            session = await self._transition(session, S.DRAFTING, Actor.of(user), "returned to crew for more briefing")
        await self._orchestrator.resume(session_id)
        return session

    async def abandon(self, user: User, session_id: str, req: AbandonRequest) -> Session:
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            self._ensure_participant(user, session)
            return await self._transition(session, S.ABANDONED, Actor.of(user), req.reason,
                                          action=AuditAction.ABANDONED, updates={"abandon_reason": req.reason})

    # ------------------------------------------------------------------ draft patches

    def _human_provenance(self, user: User, evidence: list[Any] | None = None) -> Provenance:
        return Provenance(source=Source.HUMAN, role=primary_role(user), evidence=evidence or [], confidence=1.0,
                          updated_by=user.id, updated_at=utcnow())

    def _as_human(self, patch: FormPatch, user: User) -> FormPatch:
        """Human edits are always recorded as human, whatever the client sent."""
        prov = self._human_provenance(user, patch.provenance.evidence)
        value = patch.value
        parts = patch.path.split("/")[1:]
        is_scalar_field = (len(parts) == 2 and parts[0] in SCALAR_FIELD_SECTIONS) or patch.path == "/notes"
        if is_scalar_field and patch.op != PatchOp.REMOVE and not isinstance(value, dict):
            value = {"value": value}  # UIs may send the bare value of a FieldValue
        if isinstance(value, dict) and "provenance" in value:
            value = {**value, "provenance": prov.model_dump(mode="json")}
        return patch.model_copy(update={"provenance": prov, "value": value})

    async def apply_human_patches(self, user: User, session_id: str, req: ApplyPatchesRequest) -> ApplyPatchesResult:
        patches = [self._as_human(p, user) for p in req.patches]
        return await self._apply(session_id, patches, actor=Actor.of(user), expected_revision=req.expected_revision,
                                 user=user)

    async def apply_ai_patches(self, session_id: str, req: ApplyPatchesRequest) -> ApplyPatchesResult:
        patches = []
        for p in req.patches:
            if p.provenance.source == Source.HUMAN:  # least privilege: a service cannot claim to be a person
                log.warning("ai_patch_claimed_human_source", extra={"session_id": session_id, "path": p.path})
                p = p.model_copy(update={"provenance": p.provenance.model_copy(update={"source": Source.AI})})
            patches.append(p)
        return await self._apply(session_id, patches, actor=Actor.service("orchestrator"),
                                 expected_revision=req.expected_revision, user=None)

    async def _apply(self, session_id: str, patches: list[FormPatch], *, actor: Actor,
                     expected_revision: int | None, user: User | None) -> ApplyPatchesResult:
        human = user is not None
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            if user is not None:
                self._check_can_edit(user, session)
            elif session.state not in LIVE_STATES:
                raise Conflict(f"AI patches are only accepted while briefing (session is {session.state})",
                               code="invalid_state")
            draft = await self._load_draft(session_id)
            if expected_revision is not None and expected_revision != draft.revision:
                raise Conflict(f"Draft is at revision {draft.revision}, expected {expected_revision}",
                               code="revision_conflict", extra={"current_revision": draft.revision})

            form = draft.form
            applied: list[FormPatch] = []
            rejected: list[RejectedPatch] = []
            audit: list[AuditEntry] = []
            for patch in patches:
                before = _value_at(form, patch.path)
                form, ok, bad = apply_patches(form, [patch], self.library)
                prov = patch.provenance
                common = {"path": patch.path, "model": prov.model, "prompt_version": prov.prompt_version}
                details = {"patch_id": patch.id, "op": patch.op.value, "role": prov.role,
                           "confidence": prov.confidence, "evidence": [e.segment_id for e in prov.evidence]}
                if ok:
                    stored = patch.model_copy(update={"value": _value_at(form, patch.path)})
                    applied.append(stored)
                    audit.append(self._entry(session_id, actor,
                                             AuditAction.HUMAN_EDIT if human else AuditAction.PATCH_APPLIED,
                                             before=before, after=stored.value, details=details, **common))
                else:
                    _, violation = bad[0]
                    rejected.append(RejectedPatch(patch=patch, rule=violation.rule, reason=violation.message))
                    audit.append(self._entry(session_id, actor, AuditAction.PATCH_REJECTED, after=patch.value,
                                             details={**details, "rule": violation.rule, "reason": violation.message},
                                             **common))
            if applied:
                draft = await self._save_draft(draft, form, source="human" if human else "ai", actor_id=actor.id)
            await self.repo.append_audit(audit)
            if applied:
                self._events.emit(EventType.FORM_PATCHED, session_id, {
                    "revision": draft.revision, "patches": _dump(applied), "source": "human" if human else "ai"})
                if human and session.state == S.REVIEW:
                    # The orchestrator is idle in review, so keep rule gaps current for the supervisor.
                    await self._refresh_rule_gaps(session_id, form, actor)
        if rejected:
            log.info("patches_rejected", extra={"session_id": session_id, "count": len(rejected),
                                                "rules": sorted({r.rule for r in rejected})})
        return ApplyPatchesResult(revision=draft.revision, applied=applied, rejected=rejected)

    @staticmethod
    def _check_can_edit(user: User, session: Session) -> None:
        if is_crew_lead(user, session):
            if session.state not in LEAD_EDITABLE:
                raise Conflict(f"The draft cannot be edited in {session.state}", code="invalid_state")
            return
        if user.has_role(UserRole.SUPERVISOR):
            if session.state not in SUPERVISOR_EDITABLE:
                raise Conflict(f"The draft cannot be edited in {session.state}", code="invalid_state")
            return
        if user.has_role(UserRole.CREW):
            FormService._ensure_participant(user, session)
            if session.state not in PRE_REVIEW:
                raise Forbidden("Crew can only edit the draft before it goes to review")
            return
        raise Forbidden("Only crew or supervisors can edit the draft")

    # ------------------------------------------------------------------ gaps

    async def _store_gaps(self, session_id: str, merged: list[Gap], existing: list[Gap], actor: Actor) -> bool:
        before = {g.id: g for g in existing}
        changed = [g for g in merged if before.get(g.id) != g]
        if not changed:
            return False
        await self.repo.upsert_gaps(session_id, changed)
        open_ids = [g.id for g in merged if g.status == GapStatus.OPEN]
        await self._audit(session_id, actor, AuditAction.GAPS_UPDATED,
                          details={"changed": [g.id for g in changed], "open": open_ids})
        self._emit_gaps(session_id, merged)
        return True

    async def _refresh_rule_gaps(self, session_id: str, form: Form, actor: Actor) -> list[Gap]:
        """Re-run the code rules; caller holds the lock."""
        existing = await self.repo.list_gaps(session_id)
        merged = merge_gaps(existing, gaps_from_rules(form, self.library),
                            may_resolve=lambda g: g.kind in RULE_GAP_KINDS)
        await self._store_gaps(session_id, merged, existing, actor)
        return merged

    async def upsert_gaps(self, session_id: str, gaps: list[Gap]) -> list[Gap]:
        if len({g.id for g in gaps}) != len(gaps):
            raise UnprocessableEntity("Gap ids must be unique", code="duplicate_gap_id")
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            if session.state in TERMINAL_STATES or session.state == S.SIGNED:
                raise Conflict(f"Gaps cannot change in {session.state}", code="invalid_state")
            existing = await self.repo.list_gaps(session_id)
            merged = merge_gaps(existing, gaps)
            await self._store_gaps(session_id, merged, existing, Actor.service("orchestrator"))
            return merged

    async def dismiss_gap(self, user: User, session_id: str, gap_id: str, reason: str) -> Gap:
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            _ensure_lead_or_admin(user, session, "dismiss gaps")
            if session.state not in SUPERVISOR_EDITABLE:
                raise Conflict(f"Gaps cannot change in {session.state}", code="invalid_state")
            existing = await self.repo.list_gaps(session_id)
            gap = next((g for g in existing if g.id == gap_id), None)
            if gap is None:
                raise NotFound(f"Gap {gap_id} not found")
            dismissed = gap.model_copy(update={"status": GapStatus.DISMISSED, "resolved_at": utcnow(),
                                               "resolution": reason})
            await self.repo.upsert_gaps(session_id, [dismissed])
            await self._audit(session_id, Actor.of(user), AuditAction.GAP_DISMISSED, path=gap.path,
                              before=gap.status.value, after=GapStatus.DISMISSED.value,
                              details={"gap_id": gap_id, "kind": gap.kind.value, "severity": gap.severity.value,
                                       "reason": reason})
            self._emit_gaps(session_id, [dismissed if g.id == gap_id else g for g in existing])
            return dismissed

    # ------------------------------------------------------------------ sign-off & submission

    async def sign_off(self, user: User, session_id: str, req: SignOffRequest) -> Session:
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            if session.state != S.REVIEW:
                raise Conflict(f"Session must be in REVIEW to sign off (is {session.state})", code="invalid_state")
            allowed, why = can_sign_off(user, session)
            if not allowed:
                raise Forbidden(why)
            actor = Actor.of(user)
            draft = await self._load_draft(session_id)
            gaps = await self._refresh_rule_gaps(session_id, draft.form, actor)
            blocking: list[dict[str, Any]] = [
                {"gap_id": g.id, "path": g.path, "message": g.message}
                for g in gaps if g.status == GapStatus.OPEN and g.severity == GapSeverity.BLOCKING]
            # Rule violations count unless their gap is listed above or was dismissed: a dismissal needs a
            # written reason and is audited, so it is the crew lead's explicit decision on that gap.
            decided = {b["path"] for b in blocking} | {g.path for g in gaps if g.status == GapStatus.DISMISSED}
            blocking += [{"rule": v.rule, "path": v.path, "message": v.message}
                         for v in evaluate_draft(draft.form, self.library)
                         if v.severity == GapSeverity.BLOCKING and v.path not in decided]
            if blocking:
                if not req.override_blocking_gaps:
                    raise Conflict("Blocking gaps must be resolved, or overridden with a justification",
                                   code="blocking_gaps", extra={"blocking": blocking})
                justification = (req.override_justification or "").strip()
                if not justification:
                    raise UnprocessableEntity("Overriding blocking gaps requires a written justification",
                                              code="justification_required")
                await self._audit(session_id, actor, AuditAction.GAP_OVERRIDE,
                                  details={"justification": justification, "blocking": blocking})
            return await self._transition(
                session, S.SIGNED, actor, "signed off", action=AuditAction.SIGNED_OFF,
                updates={"signed_by": user.id, "signed_at": utcnow(), "sign_off_comment": req.comment},
                details={"revision": draft.revision, "ai_draft_revision": session.ai_draft_revision,
                         "overridden": bool(blocking), "comment": req.comment})

    async def submit(self, user: User, session_id: str) -> Session:
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            if session.state == S.SUBMITTED:
                return session  # idempotent retry
            if session.state != S.SIGNED:
                raise Conflict(f"Only a signed form can be submitted (is {session.state})", code="invalid_state")
            if not (is_crew_lead(user, session) or user.has_role(UserRole.SAFETY_ADMIN)):
                raise Forbidden("Only the crew lead who started this briefing (or a safety admin) can submit")
            draft = await self._load_draft(session_id)
            payload = {"session": session.model_dump(mode="json"), "revision": draft.revision,
                       "form": draft.form.model_dump(mode="json"),
                       "gaps": _dump(await self.repo.list_gaps(session_id)), "submitted_by": user.id}
            try:
                ref = await self._submitter.submit(session_id, payload)
            except UpstreamError:
                raise
            except Exception as exc:
                log.exception("submission_failed", extra={"session_id": session_id})
                raise UpstreamError("Submission failed; the session stays SIGNED and can be resubmitted",
                                    code="submission_failed") from exc
            return await self._transition(session, S.SUBMITTED, Actor.of(user), "submitted downstream",
                                          action=AuditAction.SUBMITTED,
                                          updates={"submitted_at": utcnow(), "submission_ref": ref},
                                          details={"submission_ref": ref, "revision": draft.revision})

    # ------------------------------------------------------------------ internal (orchestrator)

    async def transition(self, session_id: str, req: TransitionRequest) -> Session:
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            return await self._transition(session, req.to, Actor.service("orchestrator"), req.reason)

    async def set_recording(self, session_id: str, recording: RecordingState) -> Session:
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            if recording == RecordingState.ACTIVE and session.state not in LIVE_STATES:
                raise Conflict(f"Cannot record in {session.state}", code="invalid_state")
            if session.recording == recording:
                return session
            before = session.recording
            session = session.model_copy(update={"recording": recording, "updated_at": utcnow()})
            await self.repo.put_session(session)
            await self._audit(session_id, Actor.service("orchestrator"), AuditAction.RECORDING_CHANGED,
                              before=before.value, after=recording.value)
            self._events.emit(EventType.RECORDING_CHANGED, session_id, {"recording": recording.value})
            self._emit_session(session)
            return session

    async def store_segments(self, session_id: str, segments: list[TranscriptSegment]) -> int:
        if any(s.session_id != session_id for s in segments):
            raise UnprocessableEntity("Every segment must belong to this session", code="session_mismatch")
        session = await self.get_session(session_id)
        if session.state not in SEGMENT_STATES:
            raise Conflict(f"Transcript is not accepted in {session.state}", code="invalid_state")
        segments = [self._name_speaker(s, session) for s in segments]
        stored = await self.repo.upsert_segments(segments)
        if stored:
            await self._audit(session_id, Actor.service("orchestrator"), AuditAction.SEGMENTS_RECEIVED,
                              details={"count": stored, "seq_range": [min(s.seq for s in segments),
                                                                      max(s.seq for s in segments)]})
        for seg in segments:
            self._events.emit(EventType.TRANSCRIPT_SEGMENT, session_id, seg.model_dump(mode="json"))
        return stored

    def _name_speaker(self, seg: TranscriptSegment, session: Session) -> TranscriptSegment:
        """Apply a reviewer's speaker assignment, and fill in names for known user ids."""
        assigned = session.speaker_assignments.get(seg.speaker_id)
        if assigned is not None and seg.user_id is None:
            return seg.model_copy(update={"user_id": assigned.user_id, "speaker_name": assigned.name})
        if seg.user_id and not seg.speaker_name and (member := self.directory.get(seg.user_id)):
            return seg.model_copy(update={"speaker_name": member.name})
        return seg

    # ------------------------------------------------------------------ speakers

    async def speakers(self, session_id: str) -> list[SpeakerInfo]:
        session = await self.get_session(session_id)
        return self._speakers(session, await self.repo.list_segments(session_id))

    @staticmethod
    def _speakers(session: Session, segments: list[TranscriptSegment]) -> list[SpeakerInfo]:
        """Voices in order of first appearance; diarized ones are labelled "Speaker 1", "Speaker 2"..."""
        info: dict[str, SpeakerInfo] = {}
        guests = 0
        for seg in segments:
            if seg.source == SegmentSource.VOICE_PROMPT:
                continue
            sp = info.get(seg.speaker_id)
            if sp is None:
                if is_diarized_speaker(seg.speaker_id):
                    guests += 1
                    label = speaker_label(guests)
                else:
                    label = seg.speaker_id
                sp = info[seg.speaker_id] = SpeakerInfo(speaker_id=seg.speaker_id, label=label, segment_count=0)
            sp.segment_count += 1
            if seg.user_id:
                sp.user_id = seg.user_id
            if seg.speaker_name and seg.speaker_name != sp.label:
                sp.name = seg.speaker_name
        for speaker_id, assigned in session.speaker_assignments.items():
            if sp := info.get(speaker_id):
                sp.user_id, sp.name = assigned.user_id, assigned.name
        return list(info.values())

    async def update_speaker(self, user: User, session_id: str, speaker_id: str, req: SpeakerUpdate
                             ) -> list[SpeakerInfo]:
        """Say who a voice is: relabels its segments and adds the person to the form's crew."""
        if not req.user_id and not req.name:
            raise UnprocessableEntity("Give a user_id or a name for this speaker", code="speaker_identity_required")
        member = None
        if req.user_id:
            member = self.directory.get(req.user_id)
            if member is None:
                raise UnprocessableEntity(f"Unknown user {req.user_id}", code="unknown_user")
        name = (req.name or (member.name if member else "")).strip()
        async with self._lock(session_id):
            session = await self.get_session(session_id)
            self._ensure_participant(user, session)
            if session.state not in LEAD_EDITABLE:
                raise Conflict(f"Speakers cannot change in {session.state}", code="invalid_state")
            segments = await self.repo.list_segments(session_id)
            mine = [s for s in segments if s.speaker_id == speaker_id and s.source != SegmentSource.VOICE_PROMPT]
            if not mine:
                raise NotFound(f"Speaker {speaker_id} not found in this transcript")
            relabelled = [s.model_copy(update={"user_id": req.user_id, "speaker_name": name}) for s in mine]
            await self.repo.upsert_segments(relabelled)

            assignments = {**session.speaker_assignments,
                           speaker_id: SpeakerAssignment(user_id=req.user_id, name=name)}
            crew_ids = session.crew_member_ids
            if req.user_id and req.user_id not in crew_ids:
                crew_ids = [*crew_ids, req.user_id]
            session = session.model_copy(update={"speaker_assignments": assignments, "crew_member_ids": crew_ids,
                                                 "updated_at": utcnow()})
            await self.repo.put_session(session)

            draft = await self._load_draft(session_id)
            crew_key = req.user_id or f"speaker:{speaker_id}"
            if crew_key not in draft.form.crew:
                form = draft.form.model_copy(deep=True)
                entry = CrewEntry(user_id=crew_key, name=name)
                form.crew[crew_key] = entry
                draft = await self._save_draft(draft, form, source=Source.HUMAN.value, actor_id=user.id)
                patch = FormPatch(op=PatchOp.ADD, path=f"/crew/{crew_key}", value=entry.model_dump(mode="json"),
                                  provenance=self._human_provenance(user))
                self._events.emit(EventType.FORM_PATCHED, session_id, {"revision": draft.revision,
                                                                       "patches": _dump([patch]), "source": "human"})
                self._events.emit(EventType.PRESENCE_UPDATED, session_id, {"crew": _dump(form.crew.values())})
            await self._audit(session_id, Actor.of(user), AuditAction.SPEAKER_LABELLED, path=f"/crew/{crew_key}",
                              after={"speaker_id": speaker_id, "user_id": req.user_id, "name": name},
                              details={"segments": len(relabelled)})
            for seg in relabelled:
                self._events.emit(EventType.TRANSCRIPT_SEGMENT, session_id, seg.model_dump(mode="json"))
            self._emit_session(session)
            return self._speakers(session, [next((r for r in relabelled if r.id == s.id), s) for s in segments])

    async def append_audit(self, session_id: str, entry: AuditEntry) -> None:
        if entry.session_id != session_id:
            raise UnprocessableEntity("Audit entry belongs to another session", code="session_mismatch")
        await self.get_session(session_id)
        await self.repo.append_audit([entry])

    # ------------------------------------------------------------------ retention

    async def delete_session(self, user: User, session_id: str, reason: str) -> Tombstone:
        """Data deletion path: hard-deletes transcript, drafts (incl. history), gaps and the session,
        leaving a tombstone. The append-only audit log is retained (it records the deletion too)."""
        async with self._lock(session_id):
            existing = await self.repo.get_tombstone(session_id)
            if existing is not None and await self.repo.get_session(session_id) is None:
                return existing
            session = await self.get_session(session_id)
            if session.state in LIVE_STATES:
                raise Conflict("Abandon or finish the briefing before deleting it", code="invalid_state")
            tombstone = Tombstone(session_id=session_id, deleted_by=user.id, reason=reason,
                                  final_state=session.state, submission_ref=session.submission_ref)
            # Tombstone first: if the purge is interrupted, a retry finds it and completes the purge.
            await self.repo.put_tombstone(tombstone)
            tombstone = tombstone.model_copy(update={"purged": await self.repo.purge_session(session_id)})
            await self.repo.put_tombstone(tombstone)
            await self._audit(session_id, Actor.of(user), AuditAction.SESSION_DELETED, before=session.state.value,
                              details={"reason": reason, "purged": tombstone.purged})
            log.info("session_deleted", extra={"session_id": session_id, "deleted_by": user.id})
            return tombstone

    # ------------------------------------------------------------------ accuracy signals

    async def diff(self, session_id: str) -> DiffResponse:
        session = await self.get_session(session_id)
        if session.ai_draft_revision is None:
            raise Conflict("The session has not reached review yet, so there is no AI draft to compare",
                           code="no_ai_draft")
        ai = await self.repo.get_draft_revision(session_id, session.ai_draft_revision)
        if ai is None:
            raise NotFound(f"Revision {session.ai_draft_revision} not found")
        final = await self._load_draft(session_id)
        roles = analytics.human_edit_roles(await self.repo.list_audit(session_id))
        return DiffResponse(ai_revision=ai.revision, final_revision=final.revision,
                            changes=analytics.diff_forms(ai.form, final.form, roles))

    async def edit_rate(self, limit: int) -> EditRateResponse:
        sessions = await self.repo.list_sessions(states=[S.SIGNED, S.SUBMITTED], limit=limit)
        pairs: list[tuple[Form, Form]] = []
        for s in sessions:
            if s.ai_draft_revision is None:
                continue
            ai = await self.repo.get_draft_revision(s.id, s.ai_draft_revision)
            final = await self.repo.get_draft(s.id)
            if ai and final:
                pairs.append((ai.form, final.form))
        return analytics.edit_rate(pairs)
