"""Local repository: one SQLite file, JSON documents per table (mirrors the Cosmos containers)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Collection
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from packages.schemas import AuditEntry, Draft, Gap, Model, Session, SessionState, TranscriptSegment

from ..models import Tombstone
from .base import RevisionConflict

if TYPE_CHECKING:
    import aiosqlite

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_sessions_state ON sessions(state, created_at);
CREATE TABLE IF NOT EXISTS drafts (
    session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS draft_revisions (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, source TEXT NOT NULL, actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, revision));
CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, start_ms INTEGER NOT NULL,
    data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_segments_session ON segments(session_id, seq, start_ms);
CREATE TABLE IF NOT EXISTS gaps (
    session_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, id));
CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_audit_session ON audit(session_id);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TABLE IF NOT EXISTS tombstones (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);
"""


def _ts(dt: datetime) -> str:
    """Fixed-width UTC timestamp so lexical order equals time order."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")


def _json(model: Model) -> str:
    return model.model_dump_json()


class SqliteRepository:
    def __init__(self, path: Path):
        self._path = path
        self._db: aiosqlite.Connection | None = None
        # One connection is shared, so multi-statement writes are serialised to keep transactions apart.
        self._write_lock = asyncio.Lock()

    @property
    def db(self) -> aiosqlite.Connection:
        if self._db is None:
            raise RuntimeError("SqliteRepository.init() has not been called")
        return self._db

    async def init(self) -> None:
        import aiosqlite

        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self._path)
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA busy_timeout=5000")
        await self._db.executescript(SCHEMA)
        await self._db.commit()
        log.info("sqlite_repository_ready", extra={"path": str(self._path)})

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    async def ping(self) -> bool:
        async with self.db.execute("SELECT 1") as cur:
            return (await cur.fetchone()) is not None

    @asynccontextmanager
    async def _tx(self) -> AsyncIterator[aiosqlite.Connection]:
        async with self._write_lock:
            try:
                yield self.db
                await self.db.commit()
            except BaseException:
                await self.db.rollback()
                raise

    async def _fetchall(self, sql: str, params: Collection[Any] = ()) -> list[tuple[Any, ...]]:
        async with self.db.execute(sql, tuple(params)) as cur:
            return list(await cur.fetchall())

    async def _fetchone(self, sql: str, params: Collection[Any] = ()) -> tuple[Any, ...] | None:
        async with self.db.execute(sql, tuple(params)) as cur:
            return await cur.fetchone()

    # ------------------------------------------------------------------ sessions

    async def insert_session(self, session: Session, draft: Draft, *, actor_id: str) -> None:
        async with self._tx() as db:
            await db.execute("INSERT INTO sessions (id, state, created_at, data) VALUES (?, ?, ?, ?)",
                             (session.id, session.state.value, _ts(session.created_at), _json(session)))
            await db.execute("INSERT INTO drafts (session_id, revision, data) VALUES (?, ?, ?)",
                             (draft.session_id, draft.revision, _json(draft)))
            await self._insert_revision(db, draft, source="human", actor_id=actor_id)

    async def get_session(self, session_id: str) -> Session | None:
        row = await self._fetchone("SELECT data FROM sessions WHERE id = ?", (session_id,))
        return Session.model_validate_json(row[0]) if row else None

    async def put_session(self, session: Session) -> None:
        async with self._tx() as db:
            await db.execute("UPDATE sessions SET state = ?, data = ? WHERE id = ?",
                             (session.state.value, _json(session), session.id))

    async def list_sessions(self, *, states: Collection[SessionState] | None = None,
                            member_id: str | None = None, limit: int = 100) -> list[Session]:
        clauses: list[str] = []
        params: list[Any] = []
        if states:
            clauses.append(f"state IN ({','.join('?' * len(states))})")
            params.extend(s.value for s in states)
        if member_id:
            clauses.append("(json_extract(data, '$.created_by') = ? OR json_extract(data, '$.supervisor_id') = ? "
                           "OR EXISTS (SELECT 1 FROM json_each(sessions.data, '$.crew_member_ids') AS m "
                           "WHERE m.value = ?))")
            params.extend([member_id] * 3)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT data FROM sessions {where} ORDER BY created_at DESC LIMIT ?"  # noqa: S608 - placeholders only
        rows = await self._fetchall(sql, [*params, limit])
        return [Session.model_validate_json(r[0]) for r in rows]

    # ------------------------------------------------------------------ drafts

    @staticmethod
    async def _insert_revision(db: aiosqlite.Connection, draft: Draft, *, source: str, actor_id: str) -> None:
        await db.execute(
            "INSERT INTO draft_revisions (session_id, revision, source, actor_id, created_at, data) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (draft.session_id, draft.revision, source, actor_id, _ts(datetime.now(UTC)), _json(draft)))

    async def get_draft(self, session_id: str) -> Draft | None:
        row = await self._fetchone("SELECT data FROM drafts WHERE session_id = ?", (session_id,))
        return Draft.model_validate_json(row[0]) if row else None

    async def save_draft(self, draft: Draft, *, expected_revision: int, source: str, actor_id: str) -> None:
        async with self._tx() as db:
            cur = await db.execute("UPDATE drafts SET revision = ?, data = ? WHERE session_id = ? AND revision = ?",
                                   (draft.revision, _json(draft), draft.session_id, expected_revision))
            if cur.rowcount != 1:
                row = await self._fetchone("SELECT revision FROM drafts WHERE session_id = ?", (draft.session_id,))
                raise RevisionConflict(draft.session_id, expected_revision, row[0] if row else None)
            await self._insert_revision(db, draft, source=source, actor_id=actor_id)

    async def get_draft_revision(self, session_id: str, revision: int) -> Draft | None:
        row = await self._fetchone("SELECT data FROM draft_revisions WHERE session_id = ? AND revision = ?",
                                   (session_id, revision))
        return Draft.model_validate_json(row[0]) if row else None

    # ------------------------------------------------------------------ transcript

    async def upsert_segments(self, segments: list[TranscriptSegment]) -> int:
        if not segments:
            return 0
        async with self._tx() as db:
            await db.executemany(
                "INSERT INTO segments (id, session_id, seq, start_ms, data) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, start_ms = excluded.start_ms, data = excluded.data",
                [(s.id, s.session_id, s.seq, s.start_ms, _json(s)) for s in segments])
        return len(segments)

    async def list_segments(self, session_id: str, *, limit: int | None = None) -> list[TranscriptSegment]:
        if limit is None:
            rows = await self._fetchall(
                "SELECT data FROM segments WHERE session_id = ? ORDER BY seq, start_ms, rowid", (session_id,))
        else:
            rows = await self._fetchall(
                "SELECT data FROM segments WHERE session_id = ? ORDER BY seq DESC, start_ms DESC, rowid DESC LIMIT ?",
                (session_id, limit))
            rows.reverse()
        return [TranscriptSegment.model_validate_json(r[0]) for r in rows]

    async def count_segments(self, session_id: str) -> int:
        row = await self._fetchone("SELECT COUNT(*) FROM segments WHERE session_id = ?", (session_id,))
        return int(row[0]) if row else 0

    # ------------------------------------------------------------------ gaps

    async def list_gaps(self, session_id: str) -> list[Gap]:
        rows = await self._fetchall("SELECT data FROM gaps WHERE session_id = ? ORDER BY rowid", (session_id,))
        return [Gap.model_validate_json(r[0]) for r in rows]

    async def upsert_gaps(self, session_id: str, gaps: list[Gap]) -> None:
        if not gaps:
            return
        async with self._tx() as db:
            await db.executemany(
                "INSERT INTO gaps (session_id, id, data) VALUES (?, ?, ?) "
                "ON CONFLICT(session_id, id) DO UPDATE SET data = excluded.data",
                [(session_id, g.id, _json(g)) for g in gaps])

    # ------------------------------------------------------------------ audit

    async def append_audit(self, entries: list[AuditEntry]) -> None:
        if not entries:
            return
        async with self._tx() as db:
            # Re-sending the same entry (a retried call) is a no-op rather than a duplicate.
            await db.executemany("INSERT OR IGNORE INTO audit (id, session_id, ts, data) VALUES (?, ?, ?, ?)",
                                 [(e.id, e.session_id, _ts(e.ts), _json(e)) for e in entries])

    async def list_audit(self, session_id: str) -> list[AuditEntry]:
        rows = await self._fetchall("SELECT data FROM audit WHERE session_id = ? ORDER BY rowid", (session_id,))
        return [AuditEntry.model_validate_json(r[0]) for r in rows]

    # ------------------------------------------------------------------ retention

    async def put_tombstone(self, tombstone: Tombstone) -> None:
        async with self._tx() as db:
            await db.execute("INSERT OR REPLACE INTO tombstones (session_id, data) VALUES (?, ?)",
                             (tombstone.session_id, _json(tombstone)))

    async def get_tombstone(self, session_id: str) -> Tombstone | None:
        row = await self._fetchone("SELECT data FROM tombstones WHERE session_id = ?", (session_id,))
        return Tombstone.model_validate_json(row[0]) if row else None

    async def purge_session(self, session_id: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        async with self._tx() as db:
            for table, column in (("segments", "session_id"), ("gaps", "session_id"),
                                  ("draft_revisions", "session_id"), ("drafts", "session_id"), ("sessions", "id")):
                cur = await db.execute(f"DELETE FROM {table} WHERE {column} = ?", (session_id,))  # noqa: S608
                counts[table] = cur.rowcount
        return counts
