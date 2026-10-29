"""Azure repository: Cosmos DB (NoSQL API), one container per collection, partitioned by ``/session_id``.

Documents are stored as ``{"id", "session_id", "doc": <model JSON>, ...sort keys}`` so queries never
depend on Cosmos system properties leaking into the models. The Azure SDK is imported lazily so
local mode never needs it.

Containers are created on startup only with key auth; with managed identity (data-plane RBAC)
they are provisioned by infrastructure-as-code and must already exist.
"""

from __future__ import annotations

import logging
from collections.abc import Collection
from datetime import UTC, datetime
from typing import Any

from packages.common.config import Settings
from packages.schemas import AuditEntry, Draft, Gap, Model, Session, SessionState, TranscriptSegment

from ..models import Tombstone
from .base import RevisionConflict

log = logging.getLogger(__name__)

CONTAINERS = ("sessions", "drafts", "draft_revisions", "segments", "gaps", "audit", "tombstones")


def _sort_key(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")


def _item(item_id: str, session_id: str, model: Model, **extra: Any) -> dict[str, Any]:
    return {"id": item_id, "session_id": session_id, "doc": model.model_dump(mode="json"), **extra}


class CosmosRepository:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._client: Any = None
        self._credential: Any = None
        self._c: dict[str, Any] = {}

    async def init(self) -> None:
        from azure.cosmos import PartitionKey  # type: ignore[import-not-found]
        from azure.cosmos.aio import CosmosClient  # type: ignore[import-not-found]

        s = self._settings
        use_key = not Settings.is_dummy(s.cosmos_key)
        if use_key:
            credential: Any = s.cosmos_key.get_secret_value()
        else:
            from azure.identity.aio import DefaultAzureCredential  # type: ignore[import-not-found]

            credential = self._credential = DefaultAzureCredential()
        self._client = CosmosClient(s.cosmos_endpoint, credential=credential)
        if use_key:
            db = await self._client.create_database_if_not_exists(s.cosmos_database)
            for name in CONTAINERS:
                self._c[name] = await db.create_container_if_not_exists(
                    id=name, partition_key=PartitionKey(path="/session_id"))
        else:
            db = self._client.get_database_client(s.cosmos_database)
            self._c = {name: db.get_container_client(name) for name in CONTAINERS}
        log.info("cosmos_repository_ready", extra={"database": s.cosmos_database, "key_auth": use_key})

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
        if self._credential is not None:
            await self._credential.close()

    async def ping(self) -> bool:
        await self._c["sessions"].read()
        return True

    async def _query(self, container: str, query: str, params: dict[str, Any],
                     session_id: str | None = None) -> list[Any]:
        kwargs: dict[str, Any] = {"query": query,
                                  "parameters": [{"name": k, "value": v} for k, v in params.items()]}
        if session_id is not None:
            kwargs["partition_key"] = session_id
        return [item async for item in self._c[container].query_items(**kwargs)]

    async def _read(self, container: str, item_id: str, session_id: str) -> dict[str, Any] | None:
        from azure.cosmos.exceptions import CosmosResourceNotFoundError  # type: ignore[import-not-found]

        try:
            return await self._c[container].read_item(item=item_id, partition_key=session_id)
        except CosmosResourceNotFoundError:
            return None

    # ------------------------------------------------------------------ sessions

    def _session_item(self, session: Session) -> dict[str, Any]:
        return _item(session.id, session.id, session, created_key=_sort_key(session.created_at))

    async def insert_session(self, session: Session, draft: Draft, *, actor_id: str) -> None:
        await self._c["sessions"].create_item(self._session_item(session))
        await self._c["drafts"].create_item(_item(session.id, session.id, draft, revision=draft.revision))
        await self._insert_revision(draft, source="human", actor_id=actor_id)

    async def get_session(self, session_id: str) -> Session | None:
        item = await self._read("sessions", session_id, session_id)
        return Session.model_validate(item["doc"]) if item else None

    async def put_session(self, session: Session) -> None:
        await self._c["sessions"].upsert_item(self._session_item(session))

    async def list_sessions(self, *, states: Collection[SessionState] | None = None,
                            member_id: str | None = None, limit: int = 100) -> list[Session]:
        clauses = ["true"]
        params: dict[str, Any] = {"@limit": limit}
        if states:
            clauses.append("ARRAY_CONTAINS(@states, c.doc.state)")
            params["@states"] = [s.value for s in states]
        if member_id:
            clauses.append("(c.doc.created_by = @member OR c.doc.supervisor_id = @member "
                           "OR ARRAY_CONTAINS(c.doc.crew_member_ids, @member))")
            params["@member"] = member_id
        query = (f"SELECT * FROM c WHERE {' AND '.join(clauses)} "  # noqa: S608 - parameterised
                 "ORDER BY c.created_key DESC OFFSET 0 LIMIT @limit")
        return [Session.model_validate(i["doc"]) for i in await self._query("sessions", query, params)]

    # ------------------------------------------------------------------ drafts

    async def _insert_revision(self, draft: Draft, *, source: str, actor_id: str) -> None:
        await self._c["draft_revisions"].upsert_item(_item(
            f"{draft.session_id}:{draft.revision}", draft.session_id, draft,
            revision=draft.revision, source=source, actor_id=actor_id))

    async def get_draft(self, session_id: str) -> Draft | None:
        item = await self._read("drafts", session_id, session_id)
        return Draft.model_validate(item["doc"]) if item else None

    async def save_draft(self, draft: Draft, *, expected_revision: int, source: str, actor_id: str) -> None:
        from azure.core import MatchConditions  # type: ignore[import-not-found]
        from azure.cosmos.exceptions import CosmosAccessConditionFailedError  # type: ignore[import-not-found]

        sid = draft.session_id
        current = await self._read("drafts", sid, sid)
        if current is None or current["revision"] != expected_revision:
            raise RevisionConflict(sid, expected_revision, current["revision"] if current else None)
        try:
            await self._c["drafts"].replace_item(item=sid, body=_item(sid, sid, draft, revision=draft.revision),
                                                 etag=current["_etag"], match_condition=MatchConditions.IfNotModified)
        except CosmosAccessConditionFailedError as exc:
            raise RevisionConflict(sid, expected_revision, None) from exc
        await self._insert_revision(draft, source=source, actor_id=actor_id)

    async def get_draft_revision(self, session_id: str, revision: int) -> Draft | None:
        item = await self._read("draft_revisions", f"{session_id}:{revision}", session_id)
        return Draft.model_validate(item["doc"]) if item else None

    # ------------------------------------------------------------------ transcript

    async def upsert_segments(self, segments: list[TranscriptSegment]) -> int:
        for seg in segments:
            await self._c["segments"].upsert_item(_item(seg.id, seg.session_id, seg, seq=seg.seq,
                                                        start_ms=seg.start_ms))
        return len(segments)

    async def list_segments(self, session_id: str, *, limit: int | None = None) -> list[TranscriptSegment]:
        if limit is None:
            items = await self._query("segments", "SELECT * FROM c ORDER BY c.seq, c.start_ms", {}, session_id)
        else:
            items = await self._query("segments", "SELECT TOP @n * FROM c ORDER BY c.seq DESC, c.start_ms DESC",
                                      {"@n": limit}, session_id)
            items.reverse()
        return [TranscriptSegment.model_validate(i["doc"]) for i in items]

    async def count_segments(self, session_id: str) -> int:
        result = await self._query("segments", "SELECT VALUE COUNT(1) FROM c", {}, session_id)
        return int(result[0]) if result else 0

    # ------------------------------------------------------------------ gaps

    async def list_gaps(self, session_id: str) -> list[Gap]:
        items = await self._query("gaps", "SELECT * FROM c ORDER BY c.created_key", {}, session_id)
        return [Gap.model_validate(i["doc"]) for i in items]

    async def upsert_gaps(self, session_id: str, gaps: list[Gap]) -> None:
        for gap in gaps:
            await self._c["gaps"].upsert_item(_item(gap.id, session_id, gap, created_key=_sort_key(gap.created_at)))

    # ------------------------------------------------------------------ audit

    async def append_audit(self, entries: list[AuditEntry]) -> None:
        from azure.cosmos.exceptions import CosmosResourceExistsError  # type: ignore[import-not-found]

        for entry in entries:
            try:  # create (never upsert): the log is append-only and retries are idempotent
                await self._c["audit"].create_item(_item(entry.id, entry.session_id, entry,
                                                         ts_key=_sort_key(entry.ts)))
            except CosmosResourceExistsError:
                continue

    async def list_audit(self, session_id: str) -> list[AuditEntry]:
        items = await self._query("audit", "SELECT * FROM c ORDER BY c.ts_key", {}, session_id)
        return [AuditEntry.model_validate(i["doc"]) for i in items]

    # ------------------------------------------------------------------ retention

    async def put_tombstone(self, tombstone: Tombstone) -> None:
        await self._c["tombstones"].upsert_item(_item(tombstone.session_id, tombstone.session_id, tombstone))

    async def get_tombstone(self, session_id: str) -> Tombstone | None:
        item = await self._read("tombstones", session_id, session_id)
        return Tombstone.model_validate(item["doc"]) if item else None

    async def purge_session(self, session_id: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        for name in ("segments", "gaps", "draft_revisions", "drafts", "sessions"):
            ids = await self._query(name, "SELECT VALUE c.id FROM c", {}, session_id)
            for item_id in ids:
                await self._c[name].delete_item(item=item_id, partition_key=session_id)
            counts[name] = len(ids)
        return counts
