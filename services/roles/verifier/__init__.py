"""Verifier: rules (and an LLM consistency pass in azure mode) -> stable gap list."""

from .heuristic import verify as verify_heuristic
from .llm import verify as verify_llm

__all__ = ["verify_heuristic", "verify_llm"]
