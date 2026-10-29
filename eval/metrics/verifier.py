"""Verifier and off-topic filtering metrics."""

from __future__ import annotations

from typing import Any

from packages.schemas import GapStatus

from ..dataset import Briefing
from ..pipeline import BriefingRun
from .base import Ratio


def _path_matches(seeded: str, actual: str) -> bool:
    return actual == seeded or actual.startswith(seeded.rstrip("/") + "/")


def seeded_gap_metrics(briefing: Briefing, run: BriefingRun) -> tuple[dict[str, Ratio], list[dict[str, Any]]]:
    """A seeded gap is caught when the final verifier pass leaves an open gap of an accepted kind at
    (or below) the seeded path."""
    open_gaps = [g for g in run.gaps if g.status == GapStatus.OPEN]
    missed: list[dict[str, Any]] = []
    caught = 0
    for seeded in briefing.seeded_gaps:
        if any(g.kind in seeded.kinds and _path_matches(seeded.path, g.path) for g in open_gaps):
            caught += 1
        else:
            near = [f"{g.kind.value} {g.path}" for g in open_gaps if _path_matches(seeded.path, g.path)]
            missed.append({"id": seeded.id, "description": seeded.description, "path": seeded.path,
                           "expected_kinds": [k.value for k in seeded.kinds], "gaps_at_path": near})
    return {
        "verifier.seeded_gap_catch_rate": Ratio(caught, len(briefing.seeded_gaps)),
        "verifier.open_gaps_per_briefing": Ratio(len(open_gaps), 1),  # alert load; pools to a mean
    }, missed


def filtering_metrics(briefing: Briefing, run: BriefingRun) -> tuple[dict[str, Ratio], dict[str, Any]]:
    """Off-topic drop rate: background / off-topic lines the analyst dropped. False drop rate:
    briefing content the analyst threw away (worse, because hazards hide there)."""
    noise = [ln for ln in briefing.transcript.lines if ln.noise]
    content = [ln for ln in briefing.transcript.lines if not ln.noise]
    dropped = run.dropped_segment_ids
    kept_noise = [ln.id for ln in noise if run.segment_id_for_line(ln.id) not in dropped]
    dropped_content = [ln.id for ln in content if run.segment_id_for_line(ln.id) in dropped]
    return {
        "analyst.offtopic_drop_rate": Ratio(len(noise) - len(kept_noise), len(noise)),
        "analyst.false_drop_rate": Ratio(len(dropped_content), len(content)),
    }, {"noise_lines_kept": kept_noise, "content_lines_dropped": dropped_content}
