"""Local development sign-in. Only mounted when ``AUTH_MODE=dev``."""

from __future__ import annotations

from fastapi import APIRouter

from packages.common.auth import mint_dev_token
from packages.common.errors import NotFound
from packages.schemas import User

from ..models import DevTokenRequest, DevTokenResponse
from . import Service

router = APIRouter(prefix="/api/auth", tags=["auth (dev only)"])


@router.post("/dev-token")
async def dev_token(body: DevTokenRequest, svc: Service) -> DevTokenResponse:
    user = svc.directory.get(body.user_id)
    if user is None:
        raise NotFound(f"Unknown user {body.user_id}")
    return DevTokenResponse(access_token=mint_dev_token(user), user=user)


@router.get("/dev-users")
async def dev_users(svc: Service) -> list[User]:
    return svc.directory.list()
