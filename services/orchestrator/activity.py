"""Plain-English one-liners and counts for each role invocation (``agent.activity`` events and the audit log).

Written for crew leads and supervisors watching the briefing: short, friendly, specific, no jargon.
"""

from __future__ import annotations

from collections import Counter

from packages.schemas import (
    ConversationAnalystRequest,
    ConversationAnalystResponse,
    FormFillerRequest,
    FormFillerResponse,
    GapSeverity,
    GapStatus,
    HazardExpertRequest,
    HazardExpertResponse,
    HazardOrigin,
    Model,
    ObservationKind,
    RoleName,
    VerifierResponse,
    VoicePrompterRequest,
    VoicePrompterResponse,
)

# Observation kinds worth naming in the analyst's summary, in reading order: (singular, plural).
_KIND_WORDS = {
    ObservationKind.HAZARD: ("hazard", "hazards"),
    ObservationKind.CONTROL: ("control", "controls"),
    ObservationKind.PPE: ("PPE item", "PPE items"),
    ObservationKind.JOB_DETAIL: ("job detail", "job details"),
    ObservationKind.TASK: ("task", "tasks"),
    ObservationKind.SITE_CONDITION: ("site condition", "site conditions"),
    ObservationKind.PERMIT: ("permit", "permits"),
    ObservationKind.EMERGENCY: ("emergency detail", "emergency details"),
    ObservationKind.ANSWER: ("answer", "answers"),
}

_FAILED = {
    RoleName.CONVERSATION_ANALYST: "Couldn't read the latest lines this time; will try again",
    RoleName.HAZARD_EXPERT: "Couldn't check the hazards this time; will try again",
    RoleName.FORM_FILLER: "Couldn't update the form this time; will try again",
    RoleName.VERIFIER: "Couldn't check the form this time; will try again",
    RoleName.VOICE_PROMPTER: "Couldn't word the questions, so the checker's own wording is used",
}


def _n(count: int, one: str, many: str | None = None) -> str:
    return f"{count} {one if count == 1 else (many or one + 's')}"


def _join(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def _crew_lines(request: ConversationAnalystRequest) -> int:
    return sum(not s.filtered for s in request.window)


def started_summary(role: RoleName, request: Model) -> str:
    if isinstance(request, ConversationAnalystRequest):
        return f"Reading the last {_n(_crew_lines(request), 'line')}…"
    if isinstance(request, HazardExpertRequest):
        return f"Checking {_n(len(request.observations), 'note')} against the hazard library…"
    if isinstance(request, FormFillerRequest):
        return f"Updating the form from {_n(len(request.assessments), 'hazard')}…"
    if isinstance(request, VoicePrompterRequest):
        return f"Wording {_n(len(request.gaps), 'question')} for the crew…"
    return "Checking the form for anything missing…"


def failed_summary(role: RoleName) -> str:
    return _FAILED.get(role, "Something went wrong; will try again")


def done_summary(request: Model, response: Model, **extra: int) -> tuple[str, dict[str, int]]:
    """``(summary, counts)`` for a finished call. ``extra`` adds counts known only to the caller
    (``rejected`` = form-filler patches stopped by the safety rules)."""
    if isinstance(response, ConversationAnalystResponse):
        assert isinstance(request, ConversationAnalystRequest)
        lines, dropped = _crew_lines(request), len(response.dropped_segment_ids)
        counts: dict[str, int] = {"lines": lines, "observations": len(response.observations), "dropped": dropped}
        kinds = Counter(o.kind for o in response.observations)
        named = [k for k in _KIND_WORDS if kinds[k]]
        found = [_n(kinds[k], *_KIND_WORDS[k]) for k in named[:3]]
        if rest := sum(kinds[k] for k in named[3:]):
            found.append(_n(rest, "other note"))
        heard = f"Heard {_n(lines, 'line')}"
        text = f"{heard}, found {_join(found)}" if found else f"{heard}, nothing new for the form"
        if dropped:
            text += f"; ignored {_n(dropped, 'off-topic line')}"
        return text, counts
    if isinstance(response, HazardExpertResponse):
        hazards = len(response.assessments)
        typical = sum(a.origin == HazardOrigin.TASK_TYPICAL for a in response.assessments)
        controls = sum(len(a.controls) for a in response.assessments)
        counts = {"hazards": hazards, "task_typical": typical, "controls": controls}
        if not hazards:
            return "No hazards to add from what was said", counts
        text = f"Matched {_n(hazards, 'hazard')} to the library"
        if typical:
            text += f" ({typical} usual for this job)"
        if controls:
            text += f" and suggested {_n(controls, 'control')}"
        return text, counts
    if isinstance(response, FormFillerResponse):
        rejected = extra.get("rejected", 0)
        written = len(response.patches) - rejected
        counts = {"patches": written, "rejected": rejected}
        text = f"Wrote {_n(written, 'update')} to the form" if written else "Nothing new to write on the form"
        if rejected:
            text += f"; safety rules blocked {rejected}"
        return text, counts
    if isinstance(response, VerifierResponse):
        open_gaps = [g for g in response.gaps if g.status == GapStatus.OPEN]
        blocking = sum(g.severity == GapSeverity.BLOCKING for g in open_gaps)
        resolved = sum(g.status == GapStatus.RESOLVED for g in response.gaps)
        counts = {"open": len(open_gaps), "blocking": blocking, "resolved": resolved}
        if not open_gaps:
            text = "Checked the form: nothing missing"
        else:
            text = f"Checked the form: {_n(len(open_gaps), 'thing')} still to sort out"
            if blocking:
                text += f" ({blocking} must be fixed before sign-off)"
        if resolved:
            text += f"; {resolved} sorted so far"
        return text, counts
    if isinstance(response, VoicePrompterResponse):
        questions = len(response.prompts)
        return f"Wrote {_n(questions, 'question')} to ask the crew", {"questions": questions}
    return "Done", {}
