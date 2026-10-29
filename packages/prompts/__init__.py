"""Versioned prompts for the LLM roles (``packages/prompts/<role>/<version>.md``)."""

from .registry import Prompt, PromptNotFound, load_prompt

__all__ = ["Prompt", "PromptNotFound", "load_prompt"]
