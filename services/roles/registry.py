"""``ROLE_HANDLERS``: one async callable per role, choosing the LLM or heuristic implementation.

The choice is made per call from ``settings.provider("llm")`` (``provider("voice")`` for the voice
prompter). When the LLM path fails and ``LLM_FALLBACK_TO_HEURISTIC`` is set, the heuristic answers
instead and its ``RoleMeta.provider`` is marked ``heuristic-fallback`` so the audit log shows it.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from packages.common.config import Provider, get_settings
from packages.schemas import RoleName

from .conversation_analyst import analyse_heuristic, analyse_llm
from .form_filler import fill_heuristic, fill_llm
from .hazard_expert import assess_heuristic, assess_llm
from .verifier import verify_heuristic, verify_llm
from .voice_prompter import prompt_azure, prompt_local

log = logging.getLogger(__name__)
FALLBACK_PROVIDER = "heuristic-fallback"

Handler = Callable[[Any], Awaitable[Any]]


def _dispatch(role: RoleName, heuristic: Handler, azure: Handler, provider_name: str = "llm") -> Handler:
    async def handle(request: Any) -> Any:
        settings = get_settings()
        if settings.provider(provider_name) != Provider.AZURE:
            return await heuristic(request)
        try:
            return await azure(request)
        except Exception as exc:
            if not settings.llm_fallback_to_heuristic:
                raise
            log.warning("role_fallback_to_heuristic", extra={"role": role.value, "error": str(exc),
                                                             "session_id": getattr(request, "session_id", None)})
            response = await heuristic(request)
            return response.model_copy(update={"meta": response.meta.model_copy(
                update={"provider": FALLBACK_PROVIDER})})

    handle.__name__ = f"handle_{role.name.lower()}"
    return handle


ROLE_HANDLERS: dict[RoleName, Handler] = {
    RoleName.CONVERSATION_ANALYST: _dispatch(RoleName.CONVERSATION_ANALYST, analyse_heuristic, analyse_llm),
    RoleName.HAZARD_EXPERT: _dispatch(RoleName.HAZARD_EXPERT, assess_heuristic, assess_llm),
    RoleName.FORM_FILLER: _dispatch(RoleName.FORM_FILLER, fill_heuristic, fill_llm),
    RoleName.VERIFIER: _dispatch(RoleName.VERIFIER, verify_heuristic, verify_llm),
    RoleName.VOICE_PROMPTER: _dispatch(RoleName.VOICE_PROMPTER, prompt_local, prompt_azure, provider_name="voice"),
}
