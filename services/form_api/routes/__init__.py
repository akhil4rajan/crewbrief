"""HTTP routes: ``public`` (/api, bearer), ``internal`` (/internal, service token), ``dev_auth`` (dev only)."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request

from packages.common.errors import UnprocessableEntity
from packages.schemas import SessionState

from ..service import FormService


def get_service(request: Request) -> FormService:
    return request.app.state.form_service


Service = Annotated[FormService, Depends(get_service)]


def parse_states(raw: str | None) -> list[SessionState] | None:
    """``?state=BRIEFING,DRAFTING`` → states; empty means no filter."""
    if not raw:
        return None
    try:
        return [SessionState(s.strip().upper()) for s in raw.split(",") if s.strip()]
    except ValueError as exc:
        raise UnprocessableEntity(f"Unknown state in {raw!r}", code="invalid_state_filter") from exc
