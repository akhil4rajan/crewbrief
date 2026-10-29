"""``python -m services.form_api`` — serve the form API on port 8001 (override with FORM_API_PORT)."""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "services.form_api.app:app",
        host=os.environ.get("FORM_API_HOST", "0.0.0.0"),
        port=int(os.environ.get("FORM_API_PORT", "8001")),
        log_config=None,  # keep the structured logging configured by the app factory
        proxy_headers=True,
    )
