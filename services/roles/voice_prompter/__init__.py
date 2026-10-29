"""Voice prompter: top open gaps -> short spoken questions (text, plus audio in azure mode)."""

from .prompter import prompt_azure, prompt_local

__all__ = ["prompt_azure", "prompt_local"]
