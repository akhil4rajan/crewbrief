from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from .common import Model


class UserRole(StrEnum):
    CREW = "crew"
    SUPERVISOR = "supervisor"
    SAFETY_ADMIN = "safety_admin"
    SERVICE = "service"  # service-to-service principal


class User(Model):
    id: str
    name: str
    email: str | None = None
    roles: list[UserRole] = Field(default_factory=list)
    crew_id: str | None = None
    employee_no: str | None = None

    def has_role(self, *roles: UserRole) -> bool:
        return any(r in self.roles for r in roles)
