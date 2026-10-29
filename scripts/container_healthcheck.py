"""Container health probe used by the Dockerfile HEALTHCHECK and docker-compose.

The slim runtime image has no curl, so this uses the standard library only.
Usage: python scripts/container_healthcheck.py [/healthz|/readyz]

The port comes from ``PORT`` if set, otherwise from the service's well-known default.
"""

from __future__ import annotations

import os
import sys
import urllib.request

DEFAULT_PORTS = {"gateway": 8000, "form_api": 8001, "orchestrator": 8002, "roles": 8003}


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "/healthz"
    service = os.environ.get("SERVICE", "gateway")
    port = int(os.environ.get("PORT") or DEFAULT_PORTS.get(service, 8000))
    url = f"http://127.0.0.1:{port}{path}"
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:  # noqa: S310 - fixed loopback URL
            return 0 if resp.status == 200 else 1
    except Exception:  # noqa: BLE001 - any failure means unhealthy
        return 1


if __name__ == "__main__":
    sys.exit(main())
