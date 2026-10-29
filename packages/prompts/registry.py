"""Load versioned role prompts.

Each prompt is a Markdown file with YAML front matter::

    ---
    version: v1
    role: conversation_analyst
    model_hint: extractor        # which deployment it was tuned for (extractor | verifier)
    output_schema: AnalystOutput # name of the response model the role validates against
    ---
    <system prompt and few-shot examples>

``version_id`` (``conversation_analyst@v1``) and the content hash are recorded in provenance and the
audit log, so every AI-filled field can be traced to the exact prompt text that produced it.
"""

from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict

PROMPTS_DIR = Path(__file__).resolve().parent


class PromptNotFound(LookupError):
    pass


class Prompt(BaseModel):
    model_config = ConfigDict(frozen=True)

    role: str
    version: str
    version_id: str  # "<role>@<version>"
    text: str  # system prompt (front matter removed)
    sha256: str
    model_hint: str | None = None
    output_schema: str | None = None


def _normalise_role(role: str) -> str:
    return str(getattr(role, "value", role)).replace("-", "_")


def load_prompt(role: str, version: str | None = None) -> Prompt:
    """Load ``packages/prompts/<role>/<version>.md``; version defaults to ``PROMPT_VERSION``."""
    if version is None:
        from packages.common.config import get_settings

        version = get_settings().prompt_version
    return _load(_normalise_role(role), version)


@lru_cache(maxsize=64)
def _load(role: str, version: str) -> Prompt:
    path = PROMPTS_DIR / role / f"{version}.md"
    if not path.is_file():
        raise PromptNotFound(f"No prompt for role {role!r} version {version!r} ({path})")
    raw = path.read_text(encoding="utf-8")
    meta: dict[str, object] = {}
    body = raw
    if raw.startswith("---"):
        _, front, body = raw.split("---", 2)
        meta = yaml.safe_load(front) or {}
    if meta.get("role", role) != role or str(meta.get("version", version)) != version:
        raise PromptNotFound(f"{path}: front matter role/version do not match its location")
    text = body.strip()
    return Prompt(role=role, version=version, version_id=f"{role}@{version}", text=text,
                  sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
                  model_hint=meta.get("model_hint"), output_schema=meta.get("output_schema"))  # type: ignore[arg-type]
