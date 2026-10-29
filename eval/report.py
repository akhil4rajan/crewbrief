"""Write ``report.json`` and a Markdown summary (timestamped, plus ``latest.*``)."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

from .metrics import Ratio, lower_is_better
from .scoring import BriefingScore, Check

LAYERS = [
    ("Transcription", "transcription."),
    ("Diarization", "diarization."),
    ("Conversation analyst", "analyst."),
    ("Hazard expert", "expert."),
    ("Form filler", "form.field"),
    ("Whole form", "form."),
    ("Verifier", "verifier."),
]

LABELS = {
    "transcription.wer": "Word error rate",
    "transcription.domain_wer": "WER on domain terms",
    "diarization.der": "Diarization error rate",
    "analyst.recall": "Hazard recall",
    "analyst.precision": "Hazard precision",
    "analyst.recall_weighted": "Hazard recall (severity-weighted)",
    "analyst.precision_weighted": "Hazard precision (severity-weighted)",
    "analyst.critical_recall": "Critical hazard recall",
    "analyst.surfaced_recall": "Hazards surfaced (present or unconfirmed)",
    "analyst.mention_recall": "Analyst raised hazard on gold span",
    "analyst.mention_recall_weighted": "Analyst raised hazard on gold span (weighted)",
    "analyst.not_present_respected": "Ruled-out hazards not marked present",
    "analyst.not_present_recorded": "Ruled-out hazards recorded as not present",
    "analyst.offtopic_drop_rate": "Off-topic lines dropped",
    "analyst.false_drop_rate": "Briefing lines wrongly dropped",
    "expert.control_recall": "Required controls retrieved",
    "expert.hazards_fully_controlled": "Hazards with all required controls",
    "expert.code_mapping": "Correct code mapping",
    "form.field_exact": "Field exact match",
    "form.field_semantic": "Field semantic match",
    "form.field_filled": "Gold fields filled",
    "form.evidence_coverage": "Evidence coverage",
    "form.hallucination_rate": "Hallucination rate",
    "form.noise_evidence_rate": "Fields supported only by off-topic chatter",
    "verifier.seeded_gap_catch_rate": "Seeded gaps caught",
    "verifier.open_gaps_per_briefing": "Open gaps per briefing (mean)",
}

PER_BRIEFING_COLUMNS = [
    ("WER", "transcription.wer"), ("DER", "diarization.der"), ("Crit recall", "analyst.critical_recall"),
    ("W recall", "analyst.recall_weighted"), ("W prec", "analyst.precision_weighted"),
    ("Ctrl", "expert.control_recall"), ("Fields", "form.field_semantic"),
    ("Evidence", "form.evidence_coverage"), ("Halluc", "form.hallucination_rate"),
    ("Gaps caught", "verifier.seeded_gap_catch_rate"), ("Drop", "analyst.offtopic_drop_rate"),
]


def fmt_value(value: float | None, key: str = "") -> str:
    if value is None:
        return "n/a"
    if key.endswith("open_gaps_per_briefing"):
        return f"{value:.1f}"
    return f"{value * 100:.1f}%"


def _ratio_cell(r: Ratio) -> str:
    num = int(r.num) if float(r.num).is_integer() else round(r.num, 1)
    den = int(r.den) if float(r.den).is_integer() else round(r.den, 1)
    return f"{num}/{den}"


def build_report(run_info: dict[str, Any], aggregate: dict[str, Ratio], scores: list[BriefingScore],
                 briefing_runs: dict[str, dict[str, Any]], checks: list[Check]) -> dict[str, Any]:
    return {
        "run": run_info,
        "passed": all(c.passed for c in checks if c.blocking),
        "gates": [c.to_json() for c in checks if c.blocking],
        "targets": [c.to_json() for c in checks if not c.blocking],
        "aggregate": {k: aggregate[k].to_json() for k in sorted(aggregate)},
        "briefings": [
            {"id": s.briefing_id, **briefing_runs.get(s.briefing_id, {}),
             "metrics": {k: v.to_json() for k, v in sorted(s.metrics.items())}, "details": s.details}
            for s in scores
        ],
    }


def _check_rows(checks: list[dict[str, Any]]) -> list[str]:
    rows = ["| Metric | Value | Threshold | Result |", "|---|---|---|---|"]
    for c in checks:
        label = LABELS.get(c["metric"], c["metric"])
        rows.append(f"| {label} (`{c['metric']}`) | {fmt_value(c['value'])} | {c['op']} {fmt_value(c['threshold'])} "
                    f"| {c['status']} |")
    return rows


def render_markdown(report: dict[str, Any]) -> str:
    run = report["run"]
    ds = run["dataset"]
    out = [f"# CrewBrief evaluation: {ds['name']} (v{ds['version']})", ""]
    out += [
        f"**Result: {'PASS' if report['passed'] else 'FAIL'}**", "",
        "| Run | |", "|---|---|",
        f"| Run id | `{run['run_id']}` |",
        f"| Started (UTC) | {run['started_at']} |",
        f"| Duration | {run['duration_s']} s |",
        f"| Dataset | `{ds['path']}`, {ds['briefings']} briefings{' (synthetic)' if ds['synthetic'] else ''} |",
        f"| Mode | `{run['mode']}` (llm: `{run['providers']['llm']}`, search: `{run['providers']['search']}`) |",
        f"| Hazard library | `{run['library_version']}` |",
        f"| Prompt version (config) | `{run['prompt_version']}` |",
        f"| Deployments | extractor `{run['deployments']['extractor']}`, "
        f"verifier `{run['deployments']['verifier']}` |",
        f"| Git commit | `{run['git']['commit']}`{' (uncommitted changes)' if run['git']['dirty'] else ''} |",
        "",
        "## Models and prompts", "",
        "| Role | Provider | Model | Prompt version | Calls | Errors | Avg latency |",
        "|---|---|---|---|---|---|---|",
    ]
    for role, info in run["roles"].items():
        out.append(f"| {role} | {info['provider']} | {info['model']} | {info['prompt_version']} | {info['calls']} "
                   f"| {info['errors']} | {info['avg_latency_ms']} ms |")
    out += ["", "## Gate", "", *_check_rows(report["gates"]), ""]
    if report["targets"]:
        out += ["## Targets (non-blocking)", "", *_check_rows(report["targets"]), ""]

    agg = report["aggregate"]
    out += ["## Aggregate metrics", "", "Pooled over all briefings (micro-average).", "",
            "| Layer | Metric | Value | n / d |", "|---|---|---|---|"]
    seen: set[str] = set()
    for layer, prefix in LAYERS:
        for key in [k for k in LABELS if k.startswith(prefix) and k in agg and k not in seen]:
            seen.add(key)
            arrow = " (lower is better)" if lower_is_better(key) else ""
            r = Ratio(agg[key]["num"], agg[key]["den"])
            out.append(f"| {layer} | {LABELS[key]}{arrow} | {fmt_value(r.value, key)} | {_ratio_cell(r)} |")
    field_keys = sorted(k for k in agg if k.startswith("form_fields."))
    if field_keys:
        out += ["", "### Field accuracy (semantic match)", "", "| Field | Value | n / d |", "|---|---|---|"]
        for key in field_keys:
            r = Ratio(agg[key]["num"], agg[key]["den"])
            out.append(f"| `/{key.removeprefix('form_fields.').replace('.', '/')}` | {fmt_value(r.value)} "
                       f"| {_ratio_cell(r)} |")

    out += ["", "## Per briefing", "",
            "| Briefing | " + " | ".join(c for c, _ in PER_BRIEFING_COLUMNS) + " | Role errors |",
            "|---|" + "---|" * (len(PER_BRIEFING_COLUMNS) + 1)]
    for b in report["briefings"]:
        cells = [fmt_value(b["metrics"].get(k, {}).get("value"), k) for _, k in PER_BRIEFING_COLUMNS]
        out.append(f"| {b['id']} | " + " | ".join(cells) + f" | {len(b.get('errors', []))} |")

    out += ["", "## Findings", ""]
    for b in report["briefings"]:
        out += _findings(b)
    return "\n".join(out).rstrip() + "\n"


def _findings(b: dict[str, Any]) -> list[str]:
    d = b["details"]
    items: list[str] = []
    if d.get("missed_hazards"):
        items.append("Missed hazards: " + ", ".join(f"`{h['code']}` ({h['severity']})" for h in d["missed_hazards"]))
    if d.get("surfaced_unconfirmed"):
        items.append("Gold hazards left unconfirmed: " + ", ".join(f"`{c}`" for c in d["surfaced_unconfirmed"]))
    if d.get("false_positive_hazards"):
        items.append("Extra hazards marked present: "
                     + ", ".join(f"`{h['code']}` ({h['severity']})" for h in d["false_positive_hazards"]))
    if d.get("ruled_out_but_present"):
        items.append("Ruled out by the crew but marked present: "
                     + ", ".join(f"`{c}`" for c in d["ruled_out_but_present"]))
    if d.get("missing_controls"):
        items.append("Required controls not retrieved: "
                     + ", ".join(f"`{m['hazard']}` -> `{m['control']}`" for m in d["missing_controls"]))
    for e in d.get("code_mapping_errors", []):
        items.append(f"Code mapping: `{e['predicted']}` where gold expects {', '.join(e['expected_any_of'])}")
    for f in d.get("field_mismatches", []):
        verdict = "semantic match" if f["semantic_match"] else "mismatch"
        items.append(f"Field `{f['field']}` ({verdict}): got {json.dumps(f['predicted'])}, "
                     f"expected {json.dumps(f['expected'][0])}")
    for p in d.get("evidence_problems", []):
        items.append(f"Evidence `{p['path']}`: {p['reason']}")
    for g in d.get("missed_seeded_gaps", []):
        items.append(f"Seeded gap missed `{g['id']}`: {g['description']} (expected {'/'.join(g['expected_kinds'])} "
                     f"at `{g['path']}`)")
    if d.get("noise_lines_kept"):
        items.append("Off-topic lines kept: " + ", ".join(d["noise_lines_kept"]))
    if d.get("content_lines_dropped"):
        items.append("Briefing lines dropped: " + ", ".join(d["content_lines_dropped"]))
    if d.get("misrecognised_domain_terms"):
        items.append("Misrecognised domain terms: " + ", ".join(d["misrecognised_domain_terms"]))
    rejected = Counter(r["rule"] for r in b.get("rejected_patches", []))
    if rejected:
        items.append("Rejected patches: " + ", ".join(f"{rule} x{n}" for rule, n in rejected.most_common()))
    items += [f"Role error: {e}" for e in b.get("errors", [])]
    items += [f"Gold warning: {w}" for w in d.get("warnings", [])]
    if not items:
        items = ["No issues."]
    return [f"### {b['id']}", "", *[f"- {i}" for i in items], ""]


def write_report(report: dict[str, Any], report_dir: Path, stamp: str) -> list[Path]:
    report_dir.mkdir(parents=True, exist_ok=True)
    body = json.dumps(report, indent=2, default=str)
    markdown = render_markdown(report)
    name = f"eval-{report['run']['dataset']['name']}-{stamp}"
    paths = []
    for stem in (name, "latest"):
        (report_dir / f"{stem}.json").write_text(body, encoding="utf-8")
        (report_dir / f"{stem}.md").write_text(markdown, encoding="utf-8")
        paths += [report_dir / f"{stem}.json", report_dir / f"{stem}.md"]
    return paths
