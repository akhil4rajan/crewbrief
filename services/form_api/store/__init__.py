"""Storage for the form API, chosen by ``settings.provider("store")``."""

from packages.common.config import Provider, Settings

from .base import Repository, RevisionConflict


def build_repository(settings: Settings) -> Repository:
    if settings.provider("store") == Provider.AZURE:
        from .cosmos import CosmosRepository

        return CosmosRepository(settings)
    from .sqlite import SqliteRepository

    return SqliteRepository(settings.sqlite_file)


__all__ = ["Repository", "RevisionConflict", "build_repository"]
