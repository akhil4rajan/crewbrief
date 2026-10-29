"""FastAPI application for the form API (port 8001)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from packages.common.app import create_app
from packages.common.config import Settings, get_settings
from packages.common.events import build_publisher
from packages.schemas import get_library

from .directory import UserDirectory
from .downstream import HttpSubmitter, OrchestratorClient, build_submitter
from .events import EventBus
from .routes import dev_auth, internal, public
from .service import FormService
from .store import build_repository


def build_app(settings: Settings | None = None) -> FastAPI:
    s = settings or get_settings()
    repo = build_repository(s)
    events = EventBus(build_publisher(s))
    orchestrator = OrchestratorClient(s.orchestrator_url)
    submitter = build_submitter(s)
    library = get_library(str(s.hazard_library_path) if s.hazard_library_path else None)
    service = FormService(repo=repo, events=events, directory=UserDirectory.from_yaml(), library=library,
                          orchestrator=orchestrator, submitter=submitter)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await repo.init()
        events.start()
        try:
            yield
        finally:
            await events.aclose()
            await orchestrator.aclose()
            if isinstance(submitter, HttpSubmitter):
                await submitter.aclose()
            await repo.close()

    app = create_app("form_api", lifespan=lifespan, readiness_checks=[repo.ping], settings=s)
    app.state.form_service = service
    app.include_router(public.router)
    app.include_router(internal.router)
    if s.auth_mode == "dev":
        app.include_router(dev_auth.router)
    return app


app = build_app()
