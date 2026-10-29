"""``python -m services.gateway`` → uvicorn on port 8000.

WebSocket protocol-level keepalive (ping every 20 s, drop after 20 s without pong) detects
dead mobile connections; ``ws_max_size`` is a hard cap above the per-frame limits enforced
by the device handler.
"""

import uvicorn

PORT = 8000

if __name__ == "__main__":
    uvicorn.run("services.gateway.app:app", host="0.0.0.0", port=PORT, ws_max_size=256 * 1024,
                ws_ping_interval=20.0, ws_ping_timeout=20.0, log_config=None)
