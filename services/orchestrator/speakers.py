"""Link transcript speakers to checked-in crew members.

No voice biometrics: a speaker is linked either because the device told us who was talking
(``user_id`` from app sign-in) or because a diarization label (``Guest-1``) introduced
itself by a checked-in crew member's name ("it's Sam", "Sam here"). Anything else stays
unknown rather than guessed.
"""

from __future__ import annotations

import re

from packages.schemas import CrewEntry, SegmentSource, TranscriptSegment

_INTRO_BEFORE = re.compile(r"\b(?:it'?s|this is|i'?m|i am|my name'?s|my name is)\s+([a-z][a-z'-]+)", re.IGNORECASE)
_INTRO_AFTER = re.compile(r"(?<!\bis\s)\b([a-z][a-z'-]+)\s+here\b(?!\s*\?)", re.IGNORECASE)


def first_name(name: str) -> str:
    return name.strip().split()[0].lower() if name.strip() else ""


class SpeakerLinker:
    def __init__(self, crew: list[CrewEntry] | None = None):
        self._crew: dict[str, CrewEntry] = {}
        self._by_first_name: dict[str, str] = {}
        self._labels: dict[str, str] = {}  # diarization label → user id
        self.update_crew(crew or [])

    def update_crew(self, crew: list[CrewEntry]) -> None:
        self._crew = {c.user_id: c for c in crew}
        names: dict[str, list[str]] = {}
        for c in crew:
            names.setdefault(first_name(c.name), []).append(c.user_id)
        # Two crew members with the same first name are ambiguous: never link by name.
        self._by_first_name = {n: ids[0] for n, ids in names.items() if n and len(ids) == 1}

    def remember(self, label: str, user_id: str) -> None:
        if label and label != user_id:
            self._labels.setdefault(label, user_id)

    def introduced_user(self, text: str) -> str | None:
        for pattern in (_INTRO_BEFORE, _INTRO_AFTER):
            for match in pattern.finditer(text):
                if user_id := self._by_first_name.get(match.group(1).lower()):
                    return user_id
        return None

    def link(self, segment: TranscriptSegment) -> TranscriptSegment:
        if segment.source == SegmentSource.VOICE_PROMPT:
            return segment
        user_id = segment.user_id
        if user_id is None:
            user_id = self._labels.get(segment.speaker_id)
            if user_id is None and (user_id := self.introduced_user(segment.text)):
                self._labels[segment.speaker_id] = user_id
        if user_id is None:
            return segment
        name = self._crew[user_id].name if user_id in self._crew else segment.speaker_name
        return segment.model_copy(update={"user_id": user_id, "speaker_name": name})

    @property
    def labels(self) -> dict[str, str]:
        return dict(self._labels)
