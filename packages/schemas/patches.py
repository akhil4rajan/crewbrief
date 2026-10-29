from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import Field

from .common import Model, Provenance, new_id


class PatchOp(StrEnum):
    ADD = "add"
    REPLACE = "replace"
    REMOVE = "remove"


class FormPatch(Model):
    """One JSON-Pointer (RFC 6901) change to the draft form, with evidence and confidence.

    ``value`` is the JSON of the target node (e.g. a full ``HazardEntry`` dict for
    ``/hazards/HZ-ELEC-LV`` or a ``FieldValue`` dict for ``/job/title``). The provenance
    on the patch is copied onto the node by the form API when the value carries none.
    """

    id: str = Field(default_factory=lambda: new_id("pat"))
    op: PatchOp
    path: str
    value: Any = None
    provenance: Provenance = Field(default_factory=Provenance)


class RejectedPatch(Model):
    patch: FormPatch
    rule: str  # rule code, e.g. "unknown_hazard_code"
    reason: str


class ApplyPatchesRequest(Model):
    patches: list[FormPatch]
    expected_revision: int | None = None  # optimistic concurrency for human edits


class ApplyPatchesResult(Model):
    revision: int
    applied: list[FormPatch] = Field(default_factory=list)
    rejected: list[RejectedPatch] = Field(default_factory=list)
