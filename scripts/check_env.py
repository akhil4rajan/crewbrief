"""Report how each integration is configured: local stand-in, or real Azure (and how it authenticates).

Never prints secret values: keys are reported only as "dummy", "set" or "empty", and endpoints
only as their host name.

    python scripts/check_env.py            # human-readable table
    python scripts/check_env.py --strict   # exit 1 if an Azure integration is misconfigured
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import SecretStr  # noqa: E402

from packages.common.config import REPO_ROOT, Provider, Settings, get_settings  # noqa: E402


@dataclass(frozen=True)
class Integration:
    name: str  # provider key used by Settings.provider()
    label: str
    endpoint_attr: str
    key_attr: str | None
    local_standin: str


INTEGRATIONS = [
    Integration("stt", "Speech-to-text", "azure_speech_endpoint", "azure_speech_key",
                "none: devices use text mode"),
    Integration("llm", "LLM roles", "azure_openai_endpoint", "azure_openai_api_key", "deterministic heuristic roles"),
    Integration("search", "Hazard search", "search_endpoint", "search_api_key", "local hazard library index"),
    Integration("store", "Draft store", "cosmos_endpoint", "cosmos_key", "SQLite"),
    Integration("pubsub", "Live updates", "webpubsub_endpoint", "webpubsub_key", "gateway WebSocket fan-out"),
    Integration("voice", "Voice prompts", "voice_live_endpoint", "voice_live_api_key", "text prompts (device TTS)"),
    Integration("pii", "PII redaction", "language_endpoint", "language_key", "local redaction stand-in"),
]


def _host(url: str) -> str:
    return urlparse(url).hostname or url


def _key_state(value: SecretStr) -> str:
    raw = value.get_secret_value()
    if not raw:
        return "empty"
    return "dummy" if Settings.is_dummy(raw) else "set"


def evaluate(s: Settings) -> tuple[list[tuple[str, ...]], list[str]]:
    rows: list[tuple[str, ...]] = []
    problems: list[str] = []
    for i in INTEGRATIONS:
        provider = s.provider(i.name)
        endpoint = str(getattr(s, i.endpoint_attr) or "")
        key_state = _key_state(getattr(s, i.key_attr)) if i.key_attr else "-"
        if provider == Provider.LOCAL:
            rows.append((i.label, "local", i.local_standin, "-"))
            continue
        if Settings.is_dummy(endpoint):
            problems.append(f"{i.label}: provider is azure but the endpoint is empty or a dummy")
            target = "MISSING ENDPOINT"
        else:
            target = _host(endpoint)
        auth = "api key" if key_state == "set" else "managed identity / az login"
        if key_state == "set" and s.environment not in ("local", "dev"):
            problems.append(f"{i.label}: an API key is configured in '{s.environment}'; use managed identity")
        rows.append((i.label, "azure", target, auth))

    telemetry = s.applicationinsights_connection_string
    rows.append(("Telemetry", "azure" if not Settings.is_dummy(telemetry) else "off",
                 "Application Insights" if not Settings.is_dummy(telemetry) else "console logs only", "-"))
    rows.append(("Auth", s.auth_mode, "Entra ID" if s.auth_mode == "entra" else "dev HS256 tokens", "-"))
    if s.auth_mode == "dev" and s.environment not in ("local", "dev"):
        problems.append(f"AUTH_MODE=dev in environment '{s.environment}'")
    if s.auth_mode == "entra" and (not s.entra_tenant_id or set(s.entra_tenant_id) <= {"0", "-"}):
        problems.append("AUTH_MODE=entra but ENTRA_TENANT_ID is not set")
    rows.append(("Submission", "remote" if s.downstream_submission_url else "local",
                 _host(s.downstream_submission_url) if s.downstream_submission_url else "./var/submissions", "-"))
    return rows, problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--strict", action="store_true", help="exit non-zero when problems are found")
    args = parser.parse_args()

    s = get_settings()
    rows, problems = evaluate(s)
    env_local = REPO_ROOT / ".env.local"
    print(f"CREWBRIEF_MODE={s.mode.value}  CREWBRIEF_ENV={s.environment}  "
          f".env.local={'present' if env_local.exists() else 'absent'}\n")
    header = ("Integration", "Provider", "Target", "Auth")
    widths = [max(len(r[c]) for r in [header, *rows]) for c in range(len(header))]
    for r in [header, tuple("-" * w for w in widths), *rows]:
        print("  ".join(cell.ljust(w) for cell, w in zip(r, widths, strict=True)))
    if problems:
        print("\nProblems:")
        for p in problems:
            print(f"  - {p}")
    return 1 if (problems and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
