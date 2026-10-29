"""Form API: owns sessions, drafts, transcript, gaps, sign-off, submission and the audit log.

It is the only writer of persisted session state. The orchestrator drives the live
briefing through ``/internal/*``; the crew app and review portal use ``/api/*``.
"""
