"""FastAPI app factory shared by all services.

Gives every service the same cross-cutting behaviour: structured logs, correlation ids,
problem+json errors, CORS, security headers, ``/healthz`` and ``/readyz``.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from packages.schemas import InvalidTransition

from .config import Settings, get_settings
from .errors import AppError
from .logging import configure_logging, correlation_id
from .telemetry import configure_telemetry

log = logging.getLogger(__name__)

ReadinessCheck = Callable[[], Awaitable[bool]]


def _problem(status: int, code: str, detail: str, request: Request, **extra: object) -> JSONResponse:
    body = {"type": f"https://crewbrief.dev/problems/{code}", "title": code, "status": status,
            "detail": detail, "instance": str(request.url.path), **extra}
    if cid := correlation_id.get():
        body["correlation_id"] = cid
    return JSONResponse(body, status_code=status, media_type="application/problem+json")


def create_app(
    service: str,
    *,
    lifespan: Callable[[FastAPI], AbstractAsyncContextManager[None]] | None = None,
    readiness_checks: list[ReadinessCheck] | None = None,
    settings: Settings | None = None,
    version: str = "0.1.0",
) -> FastAPI:
    s = settings or get_settings()
    configure_logging(service, s.log_level, s.log_format)
    configure_telemetry(service, s)

    app = FastAPI(title=f"CrewBrief {service}", version=version, lifespan=lifespan)
    app.state.settings = s
    app.state.service = service
    checks = list(readiness_checks or [])
    app.state.readiness_checks = checks

    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Correlation-Id"],
    )

    @app.middleware("http")
    async def _correlation(request: Request, call_next):  # type: ignore[no-untyped-def]
        cid = request.headers.get("x-correlation-id") or uuid.uuid4().hex
        token = correlation_id.set(cid)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            correlation_id.reset(token)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        response.headers["X-Correlation-Id"] = cid
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path not in ("/healthz", "/readyz"):
            log.info("request", extra={"method": request.method, "path": request.url.path,
                                       "status": response.status_code, "elapsed_ms": elapsed_ms,
                                       "correlation_id": cid})
        return response

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        return _problem(exc.status_code, exc.code, exc.detail, request, **exc.extra)

    @app.exception_handler(InvalidTransition)
    async def _invalid_transition(request: Request, exc: InvalidTransition) -> JSONResponse:
        return _problem(409, "invalid_transition", str(exc), request,
                        current=str(exc.current), target=str(exc.target))

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        return _problem(422, "validation_error", "Request validation failed", request,
                        errors=jsonable_errors(exc))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled_error", extra={"path": request.url.path})
        return _problem(500, "internal_error", "Unexpected error", request)

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": service, "mode": s.mode.value}

    @app.get("/readyz", tags=["ops"])
    async def readyz() -> JSONResponse:
        results = []
        for check in checks:
            try:
                results.append(await check())
            except Exception:  # noqa: BLE001
                log.exception("readiness_check_failed")
                results.append(False)
        ok = all(results)
        return JSONResponse({"status": "ready" if ok else "not_ready", "service": service},
                            status_code=200 if ok else 503)

    return app


def jsonable_errors(exc: RequestValidationError) -> list[dict[str, object]]:
    return [{"loc": list(e.get("loc", ())), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()]


async def _noop_lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
