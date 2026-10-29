"""Submission of signed forms to the downstream safety system, and orchestrator notifications."""

from __future__ import annotations

import asyncio
import json
import logging
import random
from pathlib import Path
from typing import Any, Protocol

import httpx

from packages.common.config import Settings
from packages.common.errors import UpstreamError
from packages.common.http import RETRYABLE_STATUS, InternalClient
from packages.schemas import new_id

log = logging.getLogger(__name__)


class SubmissionAdapter(Protocol):
    async def submit(self, session_id: str, payload: dict[str, Any]) -> str:
        """Deliver the signed form; return the downstream reference. Raises on failure."""


class LocalFileSubmitter:
    """Local stand-in for the safety system: one JSON file per session."""

    def __init__(self, directory: Path):
        self._dir = directory

    async def submit(self, session_id: str, payload: dict[str, Any]) -> str:
        ref = new_id("sub")
        body = json.dumps({**payload, "submission_ref": ref}, indent=2, default=str)
        await asyncio.to_thread(self._write, self._dir / f"{session_id}.json", body)
        return ref

    @staticmethod
    def _write(path: Path, body: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(path)  # atomic: a reader never sees a half-written submission


class HttpSubmitter:
    """POSTs to ``DOWNSTREAM_SUBMISSION_URL``. ``Idempotency-Key`` lets the target dedupe our retries.

    A dedicated client (not ``InternalClient``) so the internal service token never leaves the platform.
    """

    def __init__(self, url: str, *, timeout: float = 15.0, retries: int = 3):
        self._url = url
        self._retries = retries
        self._client = httpx.AsyncClient(timeout=timeout)

    async def submit(self, session_id: str, payload: dict[str, Any]) -> str:
        headers = {"Idempotency-Key": f"crewbrief-{session_id}"}
        last_error = ""
        for attempt in range(self._retries + 1):
            try:
                resp = await self._client.post(self._url, json=payload, headers=headers)
                if resp.is_success:
                    data = resp.json() if resp.content else {}
                    ref = (data.get("submission_ref") or data.get("id")) if isinstance(data, dict) else None
                    return str(ref or new_id("sub"))
                last_error = f"HTTP {resp.status_code}: {resp.text[:300]}"
                if resp.status_code not in RETRYABLE_STATUS:
                    break
            except httpx.TransportError as exc:
                last_error = str(exc)
            if attempt < self._retries:
                log.warning("downstream_submit_retry", extra={"attempt": attempt + 1, "error": last_error})
                await asyncio.sleep(min(8.0, 0.5 * 2**attempt) + random.uniform(0, 0.2))  # noqa: S311
        raise UpstreamError(f"Downstream submission failed: {last_error}", code="submission_failed")

    async def aclose(self) -> None:
        await self._client.aclose()


def build_submitter(settings: Settings) -> SubmissionAdapter:
    if settings.downstream_submission_url:
        return HttpSubmitter(settings.downstream_submission_url)
    return LocalFileSubmitter(settings.data_dir / "submissions")


class OrchestratorClient:
    """Calls the orchestrator's internal API. Failures are reported, never raised: the form API
    keeps working (and falls back locally where it matters) when the orchestrator is down."""

    def __init__(self, base_url: str):
        # The final extraction behind /end runs LLM roles, hence the generous timeout.
        self._client = InternalClient(base_url, timeout=60.0, retries=1, name="orchestrator")

    async def _post(self, session_id: str, action: str) -> bool:
        try:
            await self._client.post(f"/internal/sessions/{session_id}/{action}")
            return True
        except Exception as exc:  # noqa: BLE001 - any failure means "not reachable" to the caller
            log.warning("orchestrator_call_failed", extra={"session_id": session_id, "action": action,
                                                           "error": str(exc)})
            return False

    async def start(self, session_id: str) -> bool:
        return await self._post(session_id, "start")

    async def end(self, session_id: str) -> bool:
        return await self._post(session_id, "end")

    async def resume(self, session_id: str) -> bool:
        return await self._post(session_id, "resume")

    async def aclose(self) -> None:
        await self._client.aclose()
