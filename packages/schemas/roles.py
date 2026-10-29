"""Request/response contracts for the specialist roles.

The orchestrator calls roles either in-process (``services.roles.registry``) or over HTTP
(``POST {ROLES_URL}/roles/<role-name>``). Both use exactly these models.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from .common import Model, RoleMeta
from .form import CrewEntry, Form
from .gaps import Gap
from .observations import HazardAssessment, Observation
from .patches import FormPatch
from .transcript import TranscriptSegment


class RoleName(StrEnum):
    CONVERSATION_ANALYST = "conversation-analyst"
    HAZARD_EXPERT = "hazard-expert"
    FORM_FILLER = "form-filler"
    VERIFIER = "verifier"
    VOICE_PROMPTER = "voice-prompter"


class ConversationAnalystRequest(Model):
    session_id: str
    window: list[TranscriptSegment]  # new segments since the last run (+ a little overlap)
    crew: list[CrewEntry] = Field(default_factory=list)
    open_gaps: list[Gap] = Field(default_factory=list)  # so answers can be linked to questions
    recent_observations: list[Observation] = Field(default_factory=list)
    task_type: str | None = None


class ConversationAnalystResponse(Model):
    observations: list[Observation]
    dropped_segment_ids: list[str] = Field(default_factory=list)  # off-topic / non-crew
    task_type_hint: str | None = None
    meta: RoleMeta


class HazardExpertRequest(Model):
    session_id: str
    observations: list[Observation]
    task_type: str | None = None
    existing_hazard_codes: list[str] = Field(default_factory=list)
    include_task_typical: bool = True


class HazardExpertResponse(Model):
    assessments: list[HazardAssessment]
    task_type: str | None = None  # best task type code, if determined
    meta: RoleMeta


class FormFillerRequest(Model):
    session_id: str
    draft: Form
    observations: list[Observation]
    assessments: list[HazardAssessment]


class FormFillerResponse(Model):
    patches: list[FormPatch]
    meta: RoleMeta


class VerifierRequest(Model):
    session_id: str
    draft: Form
    transcript: list[TranscriptSegment]
    existing_gaps: list[Gap] = Field(default_factory=list)


class VerifierResponse(Model):
    gaps: list[Gap]  # full current gap list (open + resolved); ids are stable
    meta: RoleMeta


class VoicePrompt(Model):
    gap_id: str
    text: str  # short, conversational question
    priority: int = 0  # higher first
    audio_b64: str | None = None  # synthesized speech (azure mode); clients TTS locally if None
    audio_format: str | None = None  # e.g. "audio/wav;rate=24000"


class VoicePrompterRequest(Model):
    session_id: str
    gaps: list[Gap]
    already_asked_gap_ids: list[str] = Field(default_factory=list)
    max_prompts: int = 1


class VoicePrompterResponse(Model):
    prompts: list[VoicePrompt]
    meta: RoleMeta
