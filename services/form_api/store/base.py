"""The persistence boundary of the form API.

Everything is stored as JSON documents partitioned by session id, so the same shape maps onto
SQLite (local) and Cosmos DB (Azure). The audit log is append-only in both implementations.
"""

from __future__ import annotations

from collections.abc import Collection
from typing import Protocol

from packages.schemas import AuditEntry, Draft, Gap, Session, SessionState, TranscriptSegment

from ..models import Tombstone


class RevisionConflict(Exception):
    """The stored draft revision is not the one the writer read (optimistic concurrency)."""

    def __init__(self, session_id: str, expected: int, actual: int | None):
        super().__init__(f"Draft {session_id} is at revision {actual}, expected {expected}")
        self.session_id = session_id
        self.expected = expected
        self.actual = actual


class Repository(Protocol):
    async def init(self) -> None: ...
    async def close(self) -> None: ...
    async def ping(self) -> bool: ...

    # Sessions
    async def insert_session(self, session: Session, draft: Draft, *, actor_id: str) -> None:
        """Create the session together with its revision-0 draft."""
    async def get_session(self, session_id: str) -> Session | None: ...
    async def put_session(self, session: Session) -> None: ...
    async def list_sessions(self, *, states: Collection[SessionState] | None = None,
                            member_id: str | None = None, limit: int = 100) -> list[Session]:
        """Newest first. ``member_id`` matches creator, supervisor or crew member."""

    # Drafts
    async def get_draft(self, session_id: str) -> Draft | None: ...
    async def save_draft(self, draft: Draft, *, expected_revision: int, source: str, actor_id: str) -> None:
        """Conditional write (raises ``RevisionConflict``); also appends to the revision history."""
    async def get_draft_revision(self, session_id: str, revision: int) -> Draft | None: ...

    # Transcript (already PII-redacted by the gateway)
    async def upsert_segments(self, segments: list[TranscriptSegment]) -> int: ...
    async def list_segments(self, session_id: str, *, limit: int | None = None) -> list[TranscriptSegment]:
        """Ordered by ``seq``; with ``limit``, the most recent ``limit`` segments."""
    async def count_segments(self, session_id: str) -> int: ...

    # Gaps
    async def list_gaps(self, session_id: str) -> list[Gap]: ...
    async def upsert_gaps(self, session_id: str, gaps: list[Gap]) -> None: ...

    # Audit (append-only)
    async def append_audit(self, entries: list[AuditEntry]) -> None: ...
    async def list_audit(self, session_id: str) -> list[AuditEntry]: ...

    # Retention
    async def put_tombstone(self, tombstone: Tombstone) -> None: ...
    async def get_tombstone(self, session_id: str) -> Tombstone | None: ...
    async def purge_session(self, session_id: str) -> dict[str, int]:
        """Hard-delete session content (not the audit log). Returns counts per collection."""
