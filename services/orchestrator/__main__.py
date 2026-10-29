"""``python -m services.orchestrator`` → uvicorn on port 8002 (internal only)."""

import uvicorn

PORT = 8002

if __name__ == "__main__":
    uvicorn.run("services.orchestrator.app:app", host="0.0.0.0", port=PORT, log_config=None)
