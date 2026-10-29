"""User directory: seeded from YAML locally. In Azure the same interface would be backed by Entra ID."""

from __future__ import annotations

from pathlib import Path

import yaml

from packages.schemas import User, UserRole

SEED_USERS_PATH = Path(__file__).resolve().parent / "seed" / "users.yaml"


class UserDirectory:
    def __init__(self, users: list[User]):
        self._by_id = {u.id: u for u in users}

    @classmethod
    def from_yaml(cls, path: Path = SEED_USERS_PATH) -> UserDirectory:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return cls([User.model_validate(u) for u in raw.get("users", [])])

    def get(self, user_id: str) -> User | None:
        return self._by_id.get(user_id)

    def list(self, role: UserRole | None = None) -> list[User]:
        return [u for u in self._by_id.values() if role is None or role in u.roles]
