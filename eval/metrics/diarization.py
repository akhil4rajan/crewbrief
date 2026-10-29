"""Simplified frame-based diarization error rate.

DER = (missed speech + false alarm + speaker confusion) / reference speech, evaluated on fixed frames
after mapping hypothesis labels to reference speakers with the overlap-maximising one-to-one mapping
(diarization labels are arbitrary, so "Guest-2" is right if it consistently means the same person).
No forgiveness collar is applied; scripted timings are exact.
"""

from __future__ import annotations

import itertools
from collections import defaultdict
from collections.abc import Sequence
from typing import Protocol

from .base import Ratio

FRAME_MS = 10
_EXHAUSTIVE_LIMIT = 7  # speakers; beyond this fall back to greedy matching


class Turn(Protocol):
    speaker: str
    start_ms: int
    end_ms: int


def _frames(turns: Sequence[Turn]) -> dict[int, set[str]]:
    frames: dict[int, set[str]] = defaultdict(set)
    for turn in turns:
        for f in range(turn.start_ms // FRAME_MS, max(turn.start_ms // FRAME_MS + 1, turn.end_ms // FRAME_MS)):
            frames[f].add(turn.speaker)
    return frames


def _best_mapping(overlap: dict[tuple[str, str], int], refs: list[str], hyps: list[str]) -> dict[str, str]:
    """hyp label -> ref speaker maximising total overlapping frames."""
    def score(pairs: Sequence[tuple[str, str]]) -> int:
        return sum(overlap.get((r, h), 0) for r, h in pairs)

    if max(len(refs), len(hyps)) <= _EXHAUSTIVE_LIMIT:
        best: list[tuple[str, str]] = []
        best_score = -1
        small, large = (refs, hyps) if len(refs) <= len(hyps) else (hyps, refs)
        for perm in itertools.permutations(large, len(small)):
            pairs = list(zip(small, perm, strict=True)) if small is refs else list(zip(perm, small, strict=True))
            s = score(pairs)
            if s > best_score:
                best, best_score = pairs, s
        return {h: r for r, h in best}
    mapping: dict[str, str] = {}
    used: set[str] = set()
    for (r, h), _ in sorted(overlap.items(), key=lambda kv: -kv[1]):
        if h not in mapping and r not in used:
            mapping[h] = r
            used.add(r)
    return mapping


def diarization_error_rate(reference: Sequence[Turn], hypothesis: Sequence[Turn]) -> Ratio:
    ref_frames, hyp_frames = _frames(reference), _frames(hypothesis)
    overlap: dict[tuple[str, str], int] = defaultdict(int)
    for f, ref_speakers in ref_frames.items():
        for r in ref_speakers:
            for h in hyp_frames.get(f, ()):
                overlap[(r, h)] += 1
    refs = sorted({t.speaker for t in reference})
    hyps = sorted({t.speaker for t in hypothesis})
    mapping = _best_mapping(overlap, refs, hyps) if refs and hyps else {}

    errors = total = 0
    for f in set(ref_frames) | set(hyp_frames):
        ref_speakers = ref_frames.get(f, set())
        hyp_speakers = hyp_frames.get(f, set())
        correct = len(ref_speakers & {mapping.get(h) for h in hyp_speakers})
        errors += max(len(ref_speakers), len(hyp_speakers)) - correct
        total += len(ref_speakers)
    return Ratio(errors, total)
