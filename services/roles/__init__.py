"""Specialist roles: conversation analyst, hazard expert, form filler, verifier, voice prompter.

Each role has a deterministic ``heuristic`` implementation (local mode, and the degraded fallback
when the LLM fails) and an ``llm`` implementation (Azure OpenAI). ``registry.ROLE_HANDLERS`` picks
one per the configured provider; ``app`` exposes them over HTTP on port 8003.
"""
