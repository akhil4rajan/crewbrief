"""Hazard expert: observations -> library-grounded hazard assessments with recommended controls."""

from .heuristic import assess as assess_heuristic
from .llm import assess as assess_llm

__all__ = ["assess_heuristic", "assess_llm"]
