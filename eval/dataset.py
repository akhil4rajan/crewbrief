"""Gold dataset format and loader.

A dataset is a directory with ``manifest.yaml`` and one folder per briefing (see eval/README.md):

* ``transcript.json``   scripted or recorded briefing, one entry per utterance
* ``gold_form.json``    the SME-completed form for that briefing
* ``seeded_gaps.json``  gaps deliberately left in the briefing that the verifier must raise (optional)
* ``reference.txt`` / ``hypothesis.txt``              optional, overrides WER inputs
* ``diarization_ref.json`` / ``diarization_hyp.json``  optional, overrides DER inputs

Models are strict (unknown keys fail) so a typo in gold data is caught instead of silently scored.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml
from pydantic import Field, field_validator

from packages.schemas import GapKind, Model, Severity


class TranscriptLine(Model):
    id: str  # stable within the briefing, e.g. "L07"; gold evidence refers to it
    speaker: str  # diarization label the STT would emit, e.g. "Guest-1"
    user_id: str | None = None  # crew member who actually spoke; None for bystanders, radio, etc.
    text: str  # what was actually said (WER reference)
    start_ms: int
    end_ms: int
    asr_hypothesis: str | None = None  # simulated STT output; the pipeline sees this when present
    hyp_speaker: str | None = None  # simulated diarization error: the label STT assigned instead
    confidence: float = Field(default=0.92, ge=0.0, le=1.0)
    noise: bool = False  # background chatter / off-topic: the analyst should drop it

    @property
    def heard(self) -> str:
        """The text the pipeline receives."""
        return self.asr_hypothesis if self.asr_hypothesis is not None else self.text

    @property
    def heard_speaker(self) -> str:
        return self.hyp_speaker or self.speaker


class CrewMember(Model):
    user_id: str
    name: str
    role: str = "crew"


class BriefingTranscript(Model):
    briefing_id: str
    title: str = ""
    crew: list[CrewMember]
    lines: list[TranscriptLine]

    @field_validator("lines")
    @classmethod
    def _unique_ids(cls, lines: list[TranscriptLine]) -> list[TranscriptLine]:
        ids = [line.id for line in lines]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"duplicate line ids: {sorted(dupes)}")
        return lines


class GoldHazard(Model):
    code: str
    severity: Severity | None = None  # defaults to the library severity
    evidence_lines: list[str] = Field(default_factory=list)  # transcript line ids where it is discussed
    required_controls: list[str] = Field(default_factory=list)  # control codes the SME expects
    note: str = ""


class GoldNotPresent(Model):
    code: str
    evidence_lines: list[str] = Field(default_factory=list)  # where the crew ruled it out
    note: str = ""


# A gold field value is one accepted answer or a list of accepted answers.
GoldValue = str | list[str]


class GoldForm(Model):
    briefing_id: str
    job: dict[str, GoldValue] = Field(default_factory=dict)  # title, location, work_order_id, task_type, ...
    emergency: dict[str, GoldValue] = Field(default_factory=dict)  # muster_point, nearest_hospital, ...
    hazards_present: list[GoldHazard] = Field(default_factory=list)
    hazards_not_present: list[GoldNotPresent] = Field(default_factory=list)
    # Present-but-optional hazards: predicting them is not a false positive, missing them is not a miss.
    hazards_acceptable: list[str] = Field(default_factory=list)
    notes: str = ""


class SeededGap(Model):
    id: str
    description: str
    kinds: list[GapKind]  # any of these gap kinds counts as caught
    path: str  # JSON pointer; a gap at this path or below it counts
    lines: list[str] = Field(default_factory=list)  # where the gap was seeded (for humans reading the report)


class DiarizationTurn(Model):
    speaker: str
    start_ms: int
    end_ms: int


class Briefing(Model):
    id: str
    path: Path
    tags: list[str] = Field(default_factory=list)
    transcript: BriefingTranscript
    gold: GoldForm
    seeded_gaps: list[SeededGap] = Field(default_factory=list)
    reference_text: str | None = None
    hypothesis_text: str | None = None
    diarization_ref: list[DiarizationTurn] | None = None
    diarization_hyp: list[DiarizationTurn] | None = None

    def line(self, line_id: str) -> TranscriptLine | None:
        return next((ln for ln in self.transcript.lines if ln.id == line_id), None)


class Manifest(Model):
    name: str
    version: str | int = 1
    description: str = ""
    synthetic: bool = False
    language: str = "en-AU"
    domain_terms: list[str] = Field(default_factory=list)  # added to the built-in domain term list
    briefings: list[dict[str, Any]]  # {id, tags?}


class Dataset(Model):
    path: Path
    manifest: Manifest
    briefings: list[Briefing]


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _optional_text(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.exists() else None


def _optional_turns(path: Path) -> list[DiarizationTurn] | None:
    if not path.exists():
        return None
    return [DiarizationTurn.model_validate(t) for t in _read_json(path)]


def load_briefing(folder: Path, tags: list[str] | None = None) -> Briefing:
    transcript = BriefingTranscript.model_validate(_read_json(folder / "transcript.json"))
    gold = GoldForm.model_validate(_read_json(folder / "gold_form.json"))
    seeded_path = folder / "seeded_gaps.json"
    seeded = [SeededGap.model_validate(g) for g in _read_json(seeded_path)] if seeded_path.exists() else []
    briefing = Briefing(
        id=folder.name, path=folder, tags=tags or [], transcript=transcript, gold=gold, seeded_gaps=seeded,
        reference_text=_optional_text(folder / "reference.txt"),
        hypothesis_text=_optional_text(folder / "hypothesis.txt"),
        diarization_ref=_optional_turns(folder / "diarization_ref.json"),
        diarization_hyp=_optional_turns(folder / "diarization_hyp.json"),
    )
    _check_line_refs(briefing)
    return briefing


def _check_line_refs(b: Briefing) -> None:
    """Gold evidence must point at real transcript lines, otherwise span-based metrics lie."""
    known = {ln.id for ln in b.transcript.lines}
    refs = [ref for h in b.gold.hazards_present for ref in h.evidence_lines]
    refs += [ref for h in b.gold.hazards_not_present for ref in h.evidence_lines]
    refs += [ref for g in b.seeded_gaps for ref in g.lines]
    missing = sorted(set(refs) - known)
    if missing:
        raise ValueError(f"{b.id}: gold refers to unknown transcript lines {missing}")


def load_dataset(path: Path | str) -> Dataset:
    root = Path(path)
    manifest = Manifest.model_validate(yaml.safe_load((root / "manifest.yaml").read_text(encoding="utf-8")))
    briefings = [load_briefing(root / str(entry["id"]), list(entry.get("tags", []))) for entry in manifest.briefings]
    return Dataset(path=root, manifest=manifest, briefings=briefings)
