"""Deterministic hazard expert.

1. Map hazard observations to library codes (``code_hint`` first, else search retrieval).
2. Add hazards implied by site conditions and, when the task type is known, typical for the task
   (``unconfirmed``, no evidence — the crew is asked to confirm them).
3. Link controls the crew mentioned to the hazards they control (``mentioned``, planned/in place),
   then propose the library's typical controls for every hazard with their source documents.
Explicitly negated hazards with evidence become ``not_present``; silence never does.
"""

from __future__ import annotations

from packages.schemas import (
    ControlRecommendation,
    ControlStatus,
    HazardAssessment,
    HazardExpertRequest,
    HazardExpertResponse,
    HazardLibrary,
    HazardOrigin,
    HazardStatus,
    Observation,
    ObservationKind,
)

from ..common import RoleRun, library, merge_evidence

ROLE = "hazard_expert"
SEARCH_MIN_SCORE = 4.0
CONTROL_KINDS = (ObservationKind.CONTROL, ObservationKind.PPE)


async def resolve_codes(observations: list[Observation], lib: HazardLibrary) -> dict[str, str]:
    """observation id -> library code, for hazard/control observations (code_hint, else retrieval)."""
    from knowledge.search import get_search

    out: dict[str, str] = {}
    for obs in observations:
        if obs.kind == ObservationKind.HAZARD:
            valid, kinds = lib.hazard, {"hazard"}
        elif obs.kind in CONTROL_KINDS:
            valid, kinds = lib.control, {"control"}
        else:
            continue
        if obs.code_hint and valid(obs.code_hint):
            out[obs.id] = obs.code_hint
            continue
        hits = await get_search().search(obs.text, kinds=kinds, top=1)
        if hits and hits[0].score >= SEARCH_MIN_SCORE and valid(hits[0].code):
            out[obs.id] = hits[0].code
    return out


def _docs_for(lib: HazardLibrary, hazard_code: str | None = None, control_code: str | None = None) -> list[str]:
    return [d.id for d in lib.documents
            if (hazard_code and hazard_code in d.hazard_codes) or (control_code and control_code in d.control_codes)]


def build_assessments(req: HazardExpertRequest, codes: dict[str, str], lib: HazardLibrary
                      ) -> tuple[list[HazardAssessment], str | None]:
    task_type = req.task_type or next(
        (o.code_hint for o in req.observations if o.kind == ObservationKind.JOB_DETAIL
         and o.attributes.get("field") == "task_type" and o.code_hint and lib.task_type(o.code_hint)), None)
    found: dict[str, HazardAssessment] = {}

    def upsert(code: str, origin: HazardOrigin, status: HazardStatus, obs: Observation | None,
               confidence: float) -> None:
        h = lib.hazard(code)
        if h is None:
            return
        cur = found.get(code)
        ev = obs.evidence if obs else []
        ids = [obs.id] if obs else []
        if cur is None:
            found[code] = HazardAssessment(
                hazard_code=code, name=h.name, category=h.category, severity=h.severity, origin=origin,
                status=status, evidence=list(ev), confidence=confidence, observation_ids=ids,
                source_documents=list(dict.fromkeys(h.references + _docs_for(lib, hazard_code=code))))
            return
        # Present beats unconfirmed beats not-present: never let a "no" hide a later "yes".
        rank = {HazardStatus.PRESENT: 2, HazardStatus.UNCONFIRMED: 1, HazardStatus.NOT_PRESENT: 0}
        update: dict[str, object] = {"evidence": merge_evidence(cur.evidence, ev),
                                     "observation_ids": cur.observation_ids + ids,
                                     "confidence": max(cur.confidence, confidence)}
        if (rank[status] > rank[cur.status] or (cur.status == HazardStatus.NOT_PRESENT and ev)) \
                and not (status == HazardStatus.UNCONFIRMED and not ev and cur.evidence):
            update.update(status=status, origin=origin if origin == HazardOrigin.MENTIONED else cur.origin)
        found[code] = cur.model_copy(update=update)

    # 1. Hazards the crew talked about.
    for obs in req.observations:
        code = codes.get(obs.id)
        if obs.kind != ObservationKind.HAZARD or not code:
            continue
        if obs.negated:
            status = HazardStatus.NOT_PRESENT if obs.evidence else None
        elif obs.attributes.get("question"):
            status = HazardStatus.UNCONFIRMED  # asked about, not confirmed
        else:
            status = HazardStatus.PRESENT
        if status is not None:
            upsert(code, HazardOrigin.MENTIONED, status, obs, obs.confidence)

    # 2. Hazards implied by site conditions (the condition is evidenced, the hazard is to be confirmed).
    for obs in req.observations:
        if obs.kind != ObservationKind.SITE_CONDITION or obs.negated or not obs.code_hint:
            continue
        sc = next((s for s in lib.site_conditions if s.code == obs.code_hint), None)
        for code in sc.implies_hazards if sc else []:
            if code not in found and code not in req.existing_hazard_codes:
                upsert(code, HazardOrigin.SITE_CONDITION, HazardStatus.UNCONFIRMED, obs, 0.5)

    # 3. Hazards typical for the task type.
    tt = lib.task_type(task_type) if task_type else None
    if tt and req.include_task_typical:
        for code in tt.typical_hazards:
            if code not in found and code not in req.existing_hazard_codes:
                upsert(code, HazardOrigin.TASK_TYPICAL, HazardStatus.UNCONFIRMED, None, 0.4)

    # 4. Controls the crew mentioned. Answers to a voice prompt go to the hazard that was asked about;
    #    otherwise a control goes to every in-scope hazard that lists it as typical.
    scope = set(found) | set(req.existing_hazard_codes)
    mentioned: dict[str, dict[str, ControlRecommendation]] = {}

    def link(hazard_code: str, control_code: str, obs: Observation) -> None:
        c = lib.control(control_code)
        if c is None or lib.hazard(hazard_code) is None:
            return
        status = ControlStatus.IN_PLACE if obs.attributes.get("status") == "in_place" else ControlStatus.PLANNED
        bucket = mentioned.setdefault(hazard_code, {})
        prev = bucket.get(control_code)
        if prev:
            if status == ControlStatus.IN_PLACE:
                prev.status = status
            prev.evidence = merge_evidence(prev.evidence, obs.evidence)
            return
        bucket[control_code] = ControlRecommendation(
            control_code=c.code, name=c.name, type=c.type, mentioned=True, status=status,
            evidence=list(obs.evidence), confidence=obs.confidence,
            source_documents=_docs_for(lib, control_code=c.code))

    for obs in req.observations:
        if obs.kind == ObservationKind.ANSWER and (hz := obs.attributes.get("hazard_code")):
            for ccode in obs.attributes.get("control_codes") or []:
                link(str(hz), ccode, obs)
        if obs.kind not in CONTROL_KINDS or obs.negated or not (ccode := codes.get(obs.id)):
            continue
        targets = [h for h in scope if (hd := lib.hazard(h)) and ccode in hd.typical_controls]
        for h in targets:
            link(h, ccode, obs)

    # Hazards already on the form that only received controls get a carrier assessment (no evidence,
    # so the form filler adds the controls without touching the hazard's own status).
    for hazard_code in mentioned:
        if hazard_code not in found and (h := lib.hazard(hazard_code)):
            found[hazard_code] = HazardAssessment(hazard_code=hazard_code, name=h.name, category=h.category,
                                                  severity=h.severity, status=HazardStatus.PRESENT,
                                                  confidence=0.5, source_documents=h.references)

    # 5. Proposed controls from the library for everything not mentioned.
    out = []
    for code, assessment in found.items():
        h = lib.hazard(code)
        recs = dict(mentioned.get(code, {}))
        if assessment.status != HazardStatus.NOT_PRESENT and h is not None:
            for ccode in h.typical_controls:
                c = lib.control(ccode)
                if c and ccode not in recs:
                    recs[ccode] = ControlRecommendation(control_code=c.code, name=c.name, type=c.type,
                                                        confidence=0.5,
                                                        source_documents=_docs_for(lib, code, c.code))
        out.append(assessment.model_copy(update={"controls": list(recs.values())}))
    return out, task_type


async def assess(req: HazardExpertRequest) -> HazardExpertResponse:
    run = RoleRun(ROLE)
    lib = library()
    codes = await resolve_codes(req.observations, lib)
    assessments, task_type = build_assessments(req, codes, lib)
    return HazardExpertResponse(assessments=assessments, task_type=task_type, meta=run.meta())
