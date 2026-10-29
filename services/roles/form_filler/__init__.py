"""Form filler: observations + assessments -> JSON patches against the draft form."""

from .heuristic import fill as fill_heuristic
from .llm import fill as fill_llm

__all__ = ["fill_heuristic", "fill_llm"]
