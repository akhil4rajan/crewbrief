"""Offline evaluation: replay a gold dataset through the roles, score every layer, gate on thresholds.

    python eval/run_eval.py --dataset eval/datasets/sample_v1 --report eval/reports/ [--fail-under]
    python -m eval.run_eval --dataset eval/datasets/gold_v1 --mode azure --fail-under

Exit codes: 0 = done (and gates passed when --fail-under), 1 = a gate failed with --fail-under,
2 = the run could not be performed (bad dataset, roles unavailable).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if __package__ in (None, ""):
    # Run as a script: make `packages.*`, `services.*` and `eval.*` importable, and stop this folder's
    # modules shadowing top-level names.
    sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != Path(__file__).resolve().parent]
    sys.path.insert(0, str(REPO_ROOT))

logger = logging.getLogger("eval.run_eval")

HARNESS_VERSION = "1.0"


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="run_eval", description=__doc__.split("\n\n")[0])
    p.add_argument("--dataset", type=Path, required=True, help="dataset directory containing manifest.yaml")
    p.add_argument("--report", type=Path, default=REPO_ROOT / "eval" / "reports", help="report output directory")
    p.add_argument("--thresholds", type=Path, default=REPO_ROOT / "eval" / "thresholds.yaml")
    p.add_argument("--fail-under", action="store_true", help="exit 1 when a gated metric misses its threshold")
    p.add_argument("--mode", choices=["local", "azure"], help="override CREWBRIEF_MODE for this run")
    p.add_argument("--only", nargs="+", metavar="BRIEFING_ID", help="evaluate only these briefings")
    p.add_argument("--verbose", "-v", action="store_true")
    return p.parse_args(argv)


def _git_info() -> dict[str, Any]:
    def git(*args: str) -> str:
        try:
            return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, timeout=5,
                                  check=True).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""
    return {"commit": git("rev-parse", "--short=12", "HEAD") or "unknown", "dirty": bool(git("status", "--porcelain"))}


def _role_summary(runs: list[Any]) -> dict[str, dict[str, Any]]:
    summary: dict[str, dict[str, Any]] = {}
    for run in runs:
        for role, stats in run.role_stats.items():
            s = summary.setdefault(role, {"calls": 0, "errors": 0, "latency_ms": 0.0, "meta": None})
            s["calls"] += stats.calls
            s["errors"] += stats.errors
            s["latency_ms"] += stats.latency_ms
            s["meta"] = stats.meta or s["meta"]
    out = {}
    for role, s in sorted(summary.items()):
        meta = s["meta"]
        out[role] = {
            "provider": meta.provider if meta else "unknown", "model": meta.model if meta else "unknown",
            "prompt_version": meta.prompt_version if meta else "unknown",
            "calls": s["calls"], "errors": s["errors"],
            "avg_latency_ms": round(s["latency_ms"] / s["calls"], 1) if s["calls"] else 0.0,
        }
    return out


async def _replay(pipeline: Any, briefings: list[Any]) -> list[Any]:
    return [await pipeline.run(b) for b in briefings]


def _evaluate(args: argparse.Namespace) -> int:
    # Imported here so --mode is in the environment before settings are first read.
    from eval.dataset import load_dataset
    from eval.metrics import DEFAULT_DOMAIN_TERMS, pool
    from eval.pipeline import OfflinePipeline
    from eval.report import build_report, write_report
    from eval.scoring import Thresholds, score_briefing
    from packages.common.config import get_settings
    from packages.schemas import get_library

    settings = get_settings()
    try:
        dataset = load_dataset(args.dataset)
    except (OSError, ValueError) as exc:
        print(f"error: cannot load dataset {args.dataset}: {exc}", file=sys.stderr)
        return 2
    try:
        from services.roles.registry import ROLE_HANDLERS
    except ImportError as exc:
        print(f"error: roles are not importable ({exc}); run from the repo root with the venv active",
              file=sys.stderr)
        return 2

    library = get_library(str(settings.hazard_library_path) if settings.hazard_library_path else None)
    thresholds = Thresholds.load(args.thresholds)
    briefings = [b for b in dataset.briefings if not args.only or b.id in args.only]
    if not briefings:
        print("error: no briefings selected", file=sys.stderr)
        return 2

    pipeline = OfflinePipeline(
        ROLE_HANDLERS, library, interval_ms=int(settings.extraction_interval_seconds * 1000),
        verifier_every=settings.verifier_every_n_extractions, min_confidence=settings.stt_min_confidence)
    domain_terms = [*DEFAULT_DOMAIN_TERMS, *dataset.manifest.domain_terms]

    started_at = datetime.now(UTC)
    t0 = time.perf_counter()
    runs = asyncio.run(_replay(pipeline, briefings))
    scores, run_facts = [], {}
    for briefing, run in zip(briefings, runs, strict=True):
        scores.append(score_briefing(briefing, run, library, domain_terms=domain_terms,
                                     semantic_threshold=thresholds.semantic_threshold))
        run_facts[briefing.id] = {
            "tags": briefing.tags, "ticks": run.ticks, "task_type": run.task_type,
            "applied_patches": run.applied_patches, "rejected_patches": run.rejected_patches,
            "errors": run.errors, "wall_ms": round(run.wall_ms, 1),
        }
        print(f"  {briefing.id}: {run.ticks} ticks, {run.applied_patches} patches applied, "
              f"{len(run.rejected_patches)} rejected, {len(run.errors)} role errors")

    aggregate = pool([s.metrics for s in scores])
    checks = thresholds.check(aggregate)
    stamp = started_at.strftime("%Y%m%dT%H%M%SZ")
    run_info = {
        "run_id": f"{dataset.manifest.name}-{stamp}",
        "harness_version": HARNESS_VERSION,
        "started_at": started_at.isoformat(timespec="seconds"),
        "duration_s": round(time.perf_counter() - t0, 2),
        "dataset": {"name": dataset.manifest.name, "version": str(dataset.manifest.version),
                    "path": os.path.relpath(dataset.path, REPO_ROOT), "synthetic": dataset.manifest.synthetic,
                    "briefings": len(briefings)},
        "mode": settings.mode.value,
        "providers": {name: settings.provider(name).value for name in ("llm", "search", "stt")},
        "deployments": {"extractor": settings.extractor_deployment, "verifier": settings.verifier_deployment},
        "prompt_version": settings.prompt_version,
        "library_version": library.version,
        "extraction_interval_s": settings.extraction_interval_seconds,
        "verifier_every_n_extractions": settings.verifier_every_n_extractions,
        "thresholds_file": os.path.relpath(args.thresholds, REPO_ROOT) if args.thresholds.exists() else None,
        "git": _git_info(),
        "roles": _role_summary(runs),
    }
    report = build_report(run_info, aggregate, scores, run_facts, checks)
    paths = write_report(report, args.report, stamp)

    _print_summary(report)
    print("\nReport: " + ", ".join(str(p) for p in paths[:2]))
    if args.fail_under and not report["passed"]:
        return 1
    return 0


def _print_summary(report: dict[str, Any]) -> None:
    from eval.report import LABELS, fmt_value

    print(f"\n{'PASS' if report['passed'] else 'FAIL'}  {report['run']['run_id']}  "
          f"(mode {report['run']['mode']}, library {report['run']['library_version']})")
    for check in report["gates"] + report["targets"]:
        label = LABELS.get(check["metric"], check["metric"])
        print(f"  [{check['status']:>4.4s}] {label:45s} {fmt_value(check['value']):>7s}  "
              f"{check['op']} {fmt_value(check['threshold'])}")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.mode:
        os.environ["CREWBRIEF_MODE"] = args.mode
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(levelname)s %(name)s: %(message)s")
    print(f"Evaluating {args.dataset} ...")
    return _evaluate(args)


if __name__ == "__main__":
    sys.exit(main())
