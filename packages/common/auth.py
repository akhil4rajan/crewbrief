"""Authentication & authorisation.

* ``AUTH_MODE=dev``: HS256 JWTs minted by the form API's ``POST /api/auth/dev-token``
  for seeded users. Local development only.
* ``AUTH_MODE=entra``: Entra ID access tokens (RS256) validated against the tenant JWKS.
  App roles (``crew``, ``supervisor``, ``safety_admin``) come from the ``roles`` claim.

Service-to-service calls on ``/internal/*`` use ``X-Internal-Token`` locally; in Azure the
ingress for internal endpoints is not exposed publicly and managed identity tokens are used.
"""

from __future__ import annotations

import hmac
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Annotated

import jwt
from fastapi import Depends, Header, Query, Request

from packages.schemas import User, UserRole

from .config import Settings, get_settings
from .errors import Forbidden, Unauthorized

INTERNAL_TOKEN_HEADER = "X-Internal-Token"
DEV_ISSUER = "crewbrief-dev"
DEV_AUDIENCE = "crewbrief-api"


def mint_dev_token(user: User, settings: Settings | None = None) -> str:
    s = settings or get_settings()
    now = datetime.now(UTC)
    claims = {
        "iss": DEV_ISSUER,
        "aud": DEV_AUDIENCE,
        "sub": user.id,
        "name": user.name,
        "email": user.email,
        "roles": [str(r) for r in user.roles],
        "crew_id": user.crew_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=s.dev_token_ttl_minutes)).timestamp()),
    }
    return jwt.encode(claims, s.dev_jwt_secret.get_secret_value(), algorithm="HS256")


@lru_cache(maxsize=1)
def _jwks_client(tenant_id: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys")


def decode_token(token: str, settings: Settings | None = None) -> User:
    s = settings or get_settings()
    try:
        if s.auth_mode == "entra":
            key = _jwks_client(s.entra_tenant_id).get_signing_key_from_jwt(token).key
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=s.entra_api_client_id,
                issuer=f"https://login.microsoftonline.com/{s.entra_tenant_id}/v2.0",
            )
            user_id = claims.get("oid") or claims["sub"]
            email = claims.get("preferred_username")
        else:
            claims = jwt.decode(
                token,
                s.dev_jwt_secret.get_secret_value(),
                algorithms=["HS256"],
                audience=DEV_AUDIENCE,
                issuer=DEV_ISSUER,
            )
            user_id = claims["sub"]
            email = claims.get("email")
    except jwt.PyJWTError as exc:
        raise Unauthorized(f"Invalid token: {exc}") from exc
    roles = [UserRole(r) for r in claims.get("roles", []) if r in UserRole.__members__.values()]
    return User(id=user_id, name=claims.get("name", user_id), email=email, roles=roles,
                crew_id=claims.get("crew_id"))


def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


async def current_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    access_token: Annotated[str | None, Query(include_in_schema=False)] = None,
) -> User:
    """FastAPI dependency. Accepts a bearer header, or ``?access_token=`` (WebSockets)."""
    token = _bearer(authorization) or access_token
    if not token:
        raise Unauthorized("Missing bearer token")
    user = decode_token(token)
    request.state.user = user
    return user


def require_roles(*roles: UserRole):
    async def _dep(user: Annotated[User, Depends(current_user)]) -> User:
        if not user.has_role(*roles):
            raise Forbidden(f"Requires one of roles: {', '.join(roles)}")
        return user

    return _dep


def verify_internal_token(token: str | None, settings: Settings | None = None) -> bool:
    s = settings or get_settings()
    expected = s.internal_service_token.get_secret_value()
    return bool(token) and hmac.compare_digest(token, expected)


async def internal_only(x_internal_token: Annotated[str | None, Header()] = None) -> None:
    """FastAPI dependency for ``/internal/*`` service-to-service routes."""
    if not verify_internal_token(x_internal_token):
        raise Unauthorized("Internal endpoint")


def internal_headers(settings: Settings | None = None) -> dict[str, str]:
    s = settings or get_settings()
    return {INTERNAL_TOKEN_HEADER: s.internal_service_token.get_secret_value()}


CurrentUser = Annotated[User, Depends(current_user)]
