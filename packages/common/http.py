"""Resilient internal HTTP client: timeouts, retries with backoff, correlation id propagation."""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Any

import httpx

from .auth import internal_headers
from .errors import UpstreamError
from .logging import correlation_id

log = logging.getLogger(__name__)

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


class InternalClient:
    """One per target service. Reuses connections; safe to share across tasks."""

    def __init__(self, base_url: str, *, timeout: float = 10.0, retries: int = 3, name: str = ""):
        self.name = name or base_url
        self.retries = retries
        self._client = httpx.AsyncClient(base_url=base_url, timeout=timeout)

    async def request(self, method: str, path: str, *, json: Any = None,
                      params: dict[str, Any] | None = None) -> Any:
        headers = internal_headers()
        if cid := correlation_id.get():
            headers["X-Correlation-Id"] = cid
        last_exc: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                resp = await self._client.request(method, path, json=json, params=params, headers=headers)
                if resp.status_code in RETRYABLE_STATUS and attempt < self.retries:
                    raise httpx.HTTPStatusError("retryable", request=resp.request, response=resp)
                if resp.status_code >= 400:
                    raise UpstreamError(f"{self.name} {method} {path} -> {resp.status_code}: {resp.text[:500]}",
                                        extra={"upstream_status": resp.status_code})
                return resp.json() if resp.content else None
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                last_exc = exc
                if attempt >= self.retries:
                    break
                delay = min(4.0, 0.2 * 2**attempt) + random.uniform(0, 0.1)  # noqa: S311
                log.warning("internal_call_retry", extra={"target": self.name, "path": path,
                                                          "attempt": attempt + 1, "error": str(exc)})
                await asyncio.sleep(delay)
        raise UpstreamError(f"{self.name} {method} {path} failed: {last_exc}")

    async def get(self, path: str, **kw: Any) -> Any:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw: Any) -> Any:
        return await self.request("POST", path, **kw)

    async def put(self, path: str, **kw: Any) -> Any:
        return await self.request("PUT", path, **kw)

    async def aclose(self) -> None:
        await self._client.aclose()
