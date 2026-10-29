# CrewBrief evaluation harness

A form that looks complete but is wrong is worse than no form. This harness replays gold briefings
through the same extraction step the orchestrator runs live, scores every layer against a
safety-SME-completed form, and fails CI when a safety-critical metric regresses.

```bash
# from the repo root, venv active
python eval/run_eval.py --dataset eval/datasets/sample_v1 --report eval/reports/
python eval/run_eval.py --dataset eval/datasets/gold_v1 --report eval/reports/ --fail-under   # CI gate
python -m eval.run_eval --dataset eval/datasets/gold_v1 --mode azure --fail-under            # real models
```

| Option | Meaning |
|---|---|
| `--dataset DIR` | dataset directory containing `manifest.yaml` |
| `--report DIR` | where reports go (default `eval/reports/`, gitignored) |
| `--thresholds FILE` | gate config (default `eval/thresholds.yaml`) |
| `--fail-under` | exit `1` if any gated metric misses its threshold (use in CI) |
| `--mode local\|azure` | override `CREWBRIEF_MODE` for this run |
| `--only ID [ID ...]` | evaluate a subset of briefings |
| `-v` | log role warnings and pipeline info |

Exit codes: `0` finished (and gates passed when `--fail-under`), `1` a gate failed with
`--fail-under`, `2` the run could not happen (dataset invalid, roles not importable).

Each run writes `eval-<dataset>-<UTC timestamp>.json` and `.md` plus `latest.json` / `latest.md`.
Per the contributing rules, attach the Markdown report to any pull request that changes prompts,
schemas, model deployments or the hazard library.

## Modes

* `CREWBRIEF_MODE=local` (default): deterministic heuristic roles, fully offline. Fast enough for
  every pull request; it catches rule, schema, library and plumbing regressions.
* `CREWBRIEF_MODE=azure`: the roles call Azure OpenAI / AI Search as configured in `.env.local`.
  Use it to compare model deployments and prompt versions. Results vary slightly between runs.

The report records the mode, each role's provider, model and prompt version (from the roles'
`RoleMeta`), the configured deployments and prompt version, the hazard library version, and the
git commit (flagged if the tree had uncommitted changes), so a number can always be traced back to
what produced it.

## How a briefing is replayed

`eval/pipeline.py` mirrors the live session runner without any services:

1. Each transcript line becomes a `TranscriptSegment` (source `replay`). The pipeline receives the
   `asr_hypothesis` text and `hyp_speaker` label when present, i.e. what Azure Speech would have
   produced. Lines below `STT_MIN_CONFIDENCE` are filtered, as the transcription service does.
2. Segments are released in extraction ticks every `EXTRACTION_INTERVAL_SECONDS` of audio time,
   with the runner's overlap segments prefixed.
3. Every tick calls `services.orchestrator.pipeline.run_extraction` (conversation analyst, hazard
   expert, form filler, then `packages.rules.apply_patches`), the exact production step.
4. The verifier runs every `VERIFIER_EVERY_N_EXTRACTIONS` extractions and once more at the end.
   The final gap list and draft form are scored.

Role failures are recorded in the report (and the batch skipped) rather than aborting the run.
Speaker-to-crew linking uses the dataset's `user_id` (as app sign-in or device text mode would),
and checked-in crew come from the transcript's `crew` list.

## Dataset format

```
eval/datasets/<name>/
├── manifest.yaml
└── <briefing_id>/
    ├── transcript.json          # required
    ├── gold_form.json           # required: SME-completed form
    ├── seeded_gaps.json         # optional: gaps the verifier must raise
    ├── reference.txt            # optional: WER reference (overrides transcript text)
    ├── hypothesis.txt           # optional: real STT output (overrides asr_hypothesis)
    ├── diarization_ref.json     # optional: true speaker turns (overrides transcript)
    └── diarization_hyp.json     # optional: diarizer output turns
```

All files are validated strictly on load (`eval/dataset.py`): unknown keys, duplicate line ids and
gold evidence pointing at lines that do not exist are errors, not silent zeros.

### `manifest.yaml`

```yaml
name: gold_v1
version: 3
description: 20 recorded briefings from the Western region shadow pilot
synthetic: false
language: en-AU
domain_terms: [tiger tails, franna]     # added to the built-in domain term list for WER
briefings:
  - id: b01_lv_service_connection       # folder name
    tags: [lv, ewp]
```

### `transcript.json`

```jsonc
{
  "briefing_id": "b01_lv_service_connection",
  "title": "New LV overhead service connection, Penrith NSW",
  "crew": [{"user_id": "u-crew-1", "name": "Sam Taylor", "role": "leading_hand"}],
  "lines": [
    {
      "id": "L03",                       // stable id; gold evidence refers to it
      "speaker": "Guest-1",              // true diarization label
      "user_id": "u-crew-1",             // who spoke; null for bystanders, radio, public
      "text": "So we're working on live LV at the pole ...",   // what was actually said
      "start_ms": 13020, "end_ms": 19860,
      "asr_hypothesis": "So we're working on live L V at the pole ...",  // optional simulated STT output
      "hyp_speaker": "Guest-2",          // optional simulated diarization error
      "confidence": 0.92,                // optional STT confidence (default 0.92)
      "noise": false                     // true = background / off-topic: should be dropped
    }
  ]
}
```

### `gold_form.json`

Completed by a safety SME who listened to the briefing.

```jsonc
{
  "briefing_id": "b01_lv_service_connection",
  "job": {                                  // each value: one accepted answer or a list of them
    "title": ["New LV service connection", "LV overhead service connection"],
    "location": "14 Banksia Street, Penrith",
    "work_order_id": "4471823",
    "task_type": "TT-LV-CONNECT"
  },
  "emergency": {"muster_point": "...", "nearest_hospital": "Nepean Hospital",
                "first_aider": ["Sam Taylor", "u-crew-1"], "communications": "..."},
  "hazards_present": [
    {"code": "HZ-ELEC-LV", "severity": "critical",          // severity defaults to the library's
     "evidence_lines": ["L03"],                             // where the crew discussed it
     "required_controls": ["CT-ISO-LOTO", "CT-ENG-TEST-DEAD"],
     "note": "Live LV work at the pole"}
  ],
  "hazards_not_present": [{"code": "HZ-VEG", "evidence_lines": ["L12"]}],   // crew explicitly ruled out
  "hazards_acceptable": ["HZ-MANUAL"],      // optional extras: neither required nor a false positive
  "notes": "free text for reviewers"
}
```

### `seeded_gaps.json`

Gaps deliberately left in the briefing. A gap counts as caught when the final verifier pass leaves
an open gap of one of `kinds` at `path` or below it.

```json
[{"id": "SG1", "description": "Live LV work with PPE only, no isolation or engineering control",
  "kinds": ["high_risk_without_control"], "path": "/hazards/HZ-ELEC-LV", "lines": ["L03", "L04"]}]
```

### Diarization files

`diarization_ref.json` / `diarization_hyp.json`: `[{"speaker": "...", "start_ms": 0, "end_ms": 1200}]`
(RTTM-style turns). Without them DER is computed from the transcript: reference speaker = `user_id`
(or `speaker` for non-crew), hypothesis = `hyp_speaker` (or `speaker`).

## Metrics

All metrics are kept as numerator / denominator and pooled across briefings (micro-average), so
long briefings weigh more than short ones. The report shows both pooled and per-briefing values.

| Layer | Key | Definition |
|---|---|---|
| Transcription | `transcription.wer` | word-level edit distance / reference words (lower-cased, punctuation stripped) |
| | `transcription.domain_wer` | substitutions + deletions of reference tokens inside domain terms (LV/HV, EWP, earthing, isolation, ... see `metrics/text.py`) / domain tokens |
| Diarization | `diarization.der` | frame-based (10 ms) (missed + false alarm + confusion) / reference speech, after the overlap-maximising one-to-one speaker mapping; no collar |
| Conversation analyst | `analyst.recall`, `analyst.precision` | gold present hazards vs hazards marked `present` on the final form |
| | `analyst.recall_weighted`, `analyst.precision_weighted` | same, each hazard weighted by `Severity.weight` (low 1, medium 2, high 4, critical 8) |
| | `analyst.critical_recall` | recall over gold hazards of critical severity (**gate**) |
| | `analyst.surfaced_recall` | gold hazards present *or* unconfirmed (raised to the crew as a question) |
| | `analyst.mention_recall[_weighted]` | analyst in isolation: a non-negated hazard observation cites one of the SME's evidence lines, whatever its code |
| | `analyst.not_present_respected` | hazards the crew ruled out that are not marked present |
| | `analyst.not_present_recorded` | ... that are recorded as `not_present` |
| | `analyst.offtopic_drop_rate` | `noise` lines the analyst returned in `dropped_segment_ids` |
| | `analyst.false_drop_rate` | briefing lines it dropped (lower is better) |
| Hazard expert | `expert.control_recall` | SME-required controls found on the hazard (any status, including library proposals) or in the expert's assessment, for gold hazards that reached the form |
| | `expert.hazards_fully_controlled` | such hazards with every required control |
| | `expert.code_mapping` | present hazards whose evidence cites a gold hazard span and carry one of that span's gold codes |
| Form filler | `form.field_exact` | job / emergency field equals an accepted answer after normalisation |
| | `form.field_semantic` | exact, or content-token overlap F1 >= `field_semantic_threshold` (0.5) |
| | `form.field_filled`, `form_fields.<section>.<field>` | fill rate, and per-field semantic accuracy |
| Whole form | `form.evidence_coverage` | AI-filled fields citing a segment of this transcript (**gate**) |
| | `form.hallucination_rate` | AI-filled fields with no evidence, an unknown segment, or a quote not found in the transcript the pipeline received (**gate**) |
| | `form.noise_evidence_rate` | AI fields supported only by off-topic lines |
| Verifier | `verifier.seeded_gap_catch_rate` | seeded gaps caught (**gate**) |
| | `verifier.open_gaps_per_briefing` | alert load on the crew (mean) |

"AI-filled fields" are job and emergency values, notes, tasks, site conditions, PPE, permits,
hazards that are not merely `unconfirmed` suggestions, and controls the crew confirmed (not
`proposed`). Library suggestions are not claims about the briefing, so they are excluded.

Hazards are scored on the drafted form because a hazard gets its library code only once the hazard
expert has mapped the analyst's observation; `analyst.mention_recall` isolates the analyst.
Recall matters more than precision: a missed hazard costs far more than an extra one.

## Thresholds and CI

`eval/thresholds.yaml` holds the blocking `gates` and the non-blocking `targets`:

| Gate | Threshold |
|---|---|
| `analyst.critical_recall` | >= 0.98 |
| `form.evidence_coverage` | >= 0.95 |
| `form.hallucination_rate` | <= 0.02 |
| `verifier.seeded_gap_catch_rate` | >= 0.90 |

A gate with no data (empty denominator) fails. The CI step is
`python eval/run_eval.py --dataset eval/datasets/gold_v1 --fail-under` on every pull request
(`sample_v1` where the gold set is not available), publishing `latest.md` as the job summary.
Change a threshold only with the safety team's agreement, in its own pull request.

## Datasets

* `datasets/sample_v1/` (committed): six **synthetic**, scripted Australian briefings covering an LV
  service connection, a pole replacement with a crane near 11 kV lines, vegetation clearing, an
  underground cable fault with excavation, night storm restoration and padmount maintenance in a
  school zone. They include off-topic chatter, bystanders and radio traffic, simulated STT and
  diarization errors, hazards the crew rules out, and seeded gaps. They exercise every metric; they
  are not evidence of real-world accuracy.
* `datasets/gold_*/` (**never committed**, gitignored): recorded briefings with SME-completed
  forms. They contain workers' names, locations and (for recordings) voices, so keep them in
  restricted storage in Australia East and pull them into CI at run time. PII-redact transcripts
  before adding them and do not keep raw audio.

### Adding a gold briefing

1. Record (with consent) or script the briefing; transcribe it verbatim into `transcript.json`
   `text`, and put the production STT output in `asr_hypothesis` (or `hypothesis.txt`).
2. Mark background speech and off-topic chat with `"noise": true`.
3. Have a safety SME complete `gold_form.json` from the briefing alone: hazards present with codes,
   the lines that evidence them and the controls they expect; hazards the crew ruled out; job and
   emergency fields with all acceptable phrasings.
4. If the briefing intentionally omits something (no isolation for live work, no muster point),
   record it in `seeded_gaps.json`.
5. Run the harness on just that briefing (`--only <id>`) and review any disagreement with the SME
   before relying on it: fix the gold only when it is genuinely wrong.
