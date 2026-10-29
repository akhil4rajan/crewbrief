"""Azure OpenAI wrapper shared by the LLM roles.

* One ``AsyncAzureOpenAI`` client per process. Auth is managed identity (``DefaultAzureCredential``
  bearer-token provider) unless a real API key is configured for local development.
* Structured outputs: the response JSON schema is derived from the role's Pydantic output model and
  sent with ``strict: true``; the reply is then validated against the same model, so a role never
  sees unvalidated model output.
* Hard timeout per call (``LLM_TIMEOUT_SECONDS``) with the SDK's own retries for 429/5xx.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from packages.common.config import Settings, get_settings
from packages.prompts import Prompt

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)
COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
# Keywords the strict structured-output schema dialect does not accept.
_UNSUPPORTED_KEYWORDS = {"default", "title", "maxLength", "minLength", "minimum", "maximum", "format",
                         "exclusiveMinimum", "exclusiveMaximum", "pattern", "minItems", "maxItems"}


class LlmError(RuntimeError):
    """Any failure to get a valid structured answer (timeout, transport, refusal, schema)."""


@dataclass
class LlmResult[T: BaseModel]:
    output: T
    model: str
    tokens_in: int | None
    tokens_out: int | None
    latency_ms: int


def strict_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Pydantic JSON schema adapted to Azure OpenAI strict mode (all properties required, no extras)."""

    def fix(node: Any) -> Any:
        if isinstance(node, dict):
            node = {k: fix(v) for k, v in node.items() if k not in _UNSUPPORTED_KEYWORDS}
            if node.get("type") == "object" and "properties" in node:
                node["required"] = list(node["properties"])
                node["additionalProperties"] = False
            return node
        if isinstance(node, list):
            return [fix(v) for v in node]
        return node

    return fix(copy.deepcopy(model.model_json_schema()))


_client: Any = None
_credential: Any = None


def _get_client(settings: Settings) -> Any:
    global _client, _credential
    if _client is None:
        from openai import AsyncAzureOpenAI

        if not settings.azure_openai_endpoint or Settings.is_dummy(settings.azure_openai_endpoint):
            raise LlmError("AZURE_OPENAI_ENDPOINT is not configured")
        kwargs: dict[str, Any] = {"azure_endpoint": settings.azure_openai_endpoint,
                                  "api_version": settings.azure_openai_api_version, "max_retries": 2,
                                  "timeout": settings.llm_timeout_seconds}
        if Settings.is_dummy(settings.azure_openai_api_key):
            from azure.identity.aio import DefaultAzureCredential, get_bearer_token_provider

            _credential = DefaultAzureCredential()
            kwargs["azure_ad_token_provider"] = get_bearer_token_provider(_credential, COGNITIVE_SERVICES_SCOPE)
        else:
            kwargs["api_key"] = settings.azure_openai_api_key.get_secret_value()
        _client = AsyncAzureOpenAI(**kwargs)
    return _client


async def complete_json(*, deployment: str, prompt: Prompt, payload: dict[str, Any], output_model: type[T],
                        settings: Settings | None = None, temperature: float = 0.0) -> LlmResult[T]:
    """Run one chat completion and return the validated structured output."""
    s = settings or get_settings()
    client = _get_client(s)
    response_format = {"type": "json_schema", "json_schema": {
        "name": output_model.__name__, "schema": strict_json_schema(output_model), "strict": True}}
    messages = [{"role": "system", "content": prompt.text},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False, default=str)}]
    started = time.perf_counter()
    try:
        resp = await asyncio.wait_for(
            client.chat.completions.create(model=deployment, messages=messages, temperature=temperature,
                                           response_format=response_format),
            timeout=s.llm_timeout_seconds)
    except TimeoutError as exc:
        raise LlmError(f"{deployment} timed out after {s.llm_timeout_seconds}s") from exc
    except Exception as exc:  # noqa: BLE001 - SDK raises many transport/HTTP error types
        raise LlmError(f"{deployment} call failed: {exc}") from exc
    latency_ms = int((time.perf_counter() - started) * 1000)

    choice = resp.choices[0]
    if getattr(choice.message, "refusal", None):
        raise LlmError(f"{deployment} refused: {choice.message.refusal}")
    if choice.finish_reason not in (None, "stop"):
        raise LlmError(f"{deployment} stopped early: {choice.finish_reason}")
    try:
        output = output_model.model_validate_json(choice.message.content or "")
    except ValidationError as exc:
        raise LlmError(f"{deployment} returned output that does not match {output_model.__name__}: "
                       f"{exc.errors()[:3]}") from exc
    usage = getattr(resp, "usage", None)
    log.info("llm_call", extra={"deployment": deployment, "prompt_version": prompt.version_id,
                                "latency_ms": latency_ms,
                                "tokens_in": getattr(usage, "prompt_tokens", None),
                                "tokens_out": getattr(usage, "completion_tokens", None)})
    return LlmResult(output=output, model=getattr(resp, "model", None) or deployment,
                     tokens_in=getattr(usage, "prompt_tokens", None),
                     tokens_out=getattr(usage, "completion_tokens", None), latency_ms=latency_ms)


def library_catalogue(kinds: tuple[str, ...] = ("hazards", "controls", "task_types", "site_conditions")
                      ) -> dict[str, list[str]]:
    """Compact ``CODE: name`` lists of the library, given to the LLM so it can propose valid codes."""
    from .common import library

    lib = library()
    sections = {"hazards": [f"{h.code}: {h.name}" for h in lib.hazards],
                "controls": [f"{c.code}: {c.name} ({c.type.value})" for c in lib.controls],
                "task_types": [f"{t.code}: {t.name}" for t in lib.task_types],
                "site_conditions": [f"{s.code}: {s.name}" for s in lib.site_conditions]}
    return {k: v for k, v in sections.items() if k in kinds}
