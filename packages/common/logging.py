"""Structured JSON logging with request / session correlation."""

from __future__ import annotations

import contextvars
import json
import logging
import re
import sys
from datetime import UTC, datetime

correlation_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("correlation_id", default=None)
session_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("session_id", default=None)

_RESERVED = set(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime"}
_TOKEN_RE = re.compile(r"(access_token=|[Bb]earer\s+)[A-Za-z0-9._~+/=-]+")


class RedactTokensFilter(logging.Filter):
    """Bearer tokens travel in WebSocket query strings; never let them reach the logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "access_token=" in message or "earer " in message:
            record.msg = _TOKEN_RE.sub(r"\1[redacted]", message)
            record.args = None
        return True


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "service": self.service,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if cid := correlation_id.get():
            payload["correlation_id"] = cid
        if sid := session_id_var.get():
            payload["session_id"] = sid
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class ConsoleFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__(f"%(asctime)s %(levelname)-7s [{service}] %(name)s: %(message)s", "%H:%M:%S")


def configure_logging(service: str, level: str = "INFO", fmt: str = "json") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service) if fmt == "json" else ConsoleFormatter(service))
    handler.addFilter(RedactTokensFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for noisy in ("httpx", "httpcore", "uvicorn.access", "azure"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
