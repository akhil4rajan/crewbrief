"""Run the roles service: ``python -m services.roles`` (port 8003, or ``$PORT``)."""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run("services.roles.app:app", host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8003")),
                log_config=None)
