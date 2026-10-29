"""Segment filters.

Filtered segments are *kept* (stored and visible in the audit trail) but flagged so the
extraction roles skip them. Nothing the crew said is silently discarded.
"""

from __future__ import annotations

import re

from packages.schemas import TranscriptSegment

# Words that carry no safety content on their own. "yes"/"no" are deliberately absent:
# they can be answers to a voice prompt.
FILLER_WORDS = frozenset({
    "um", "umm", "uh", "uhh", "er", "erm", "ah", "eh", "hmm", "mm", "mhm", "uh-huh",
    "yeah", "yep", "yup", "ok", "okay", "right", "so", "like", "alright", "cool",
})

_WORD = re.compile(r"[a-z0-9]+(?:[-'][a-z0-9]+)*")


def filter_reason(segment: TranscriptSegment, min_confidence: float) -> str | None:
    words = _WORD.findall(segment.text.lower())
    if not words:
        return "empty"
    if segment.confidence < min_confidence:
        return "low_confidence"
    if all(w in FILLER_WORDS for w in words):
        return "filler"
    return None


def apply_filters(segment: TranscriptSegment, min_confidence: float) -> TranscriptSegment:
    """Flag a segment that should not reach extraction. Already-filtered segments are left alone."""
    if segment.filtered:
        return segment
    reason = filter_reason(segment, min_confidence)
    if reason is None:
        return segment
    return segment.model_copy(update={"filtered": True, "filter_reason": reason})
