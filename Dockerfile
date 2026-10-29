# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# One image for every CrewBrief backend service. SERVICE selects the entrypoint:
#   docker run -e SERVICE=gateway crewbrief          -> python -m services.gateway
# Valid values: gateway | form_api | orchestrator | roles
#
# Build args:
#   EXTRAS   optional dependency groups from pyproject.toml (default: azure, so the
#            same image runs in local and azure mode). Use EXTRAS="" for a lean image.
#   SERVICE  default service baked into the image (azd builds one tag per service).
# -----------------------------------------------------------------------------
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.32

FROM ${UV_IMAGE} AS uv

# --- Build stage: resolve and install dependencies into an isolated venv ------
FROM ${PYTHON_IMAGE} AS builder
ARG EXTRAS=azure
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_CACHE=1 \
    VIRTUAL_ENV=/opt/venv
WORKDIR /build

# Dependencies change far less often than code: install them from pyproject.toml alone
# so this layer stays cached across source edits.
COPY pyproject.toml ./
RUN uv venv "$VIRTUAL_ENV" \
 && extras_flags="" \
 && for e in $(echo "$EXTRAS" | tr ',' ' '); do extras_flags="$extras_flags --extra $e"; done \
 && uv pip compile pyproject.toml $extras_flags --python-version 3.12 -o requirements.txt \
 && uv pip install --python "$VIRTUAL_ENV/bin/python" -r requirements.txt

# --- Runtime stage: no compilers, no uv, non-root ------------------------------
FROM ${PYTHON_IMAGE} AS runtime
ARG SERVICE=gateway
LABEL org.opencontainers.image.title="crewbrief-backend" \
      org.opencontainers.image.description="CrewBrief backend services (gateway, form_api, orchestrator, roles)" \
      org.opencontainers.image.source="https://github.com/akhil4rajan/crewbrief" \
      org.opencontainers.image.licenses="UNLICENSED"

# libasound2: runtime dependency of the Azure Speech SDK native library (no audio device is used).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libasound2 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 crewbrief \
 && useradd --system --uid 10001 --gid crewbrief --home-dir /app --shell /usr/sbin/nologin crewbrief

ENV PATH="/opt/venv/bin:$PATH" \
    VIRTUAL_ENV=/opt/venv \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/var \
    LOG_FORMAT=json \
    SERVICE=${SERVICE}

WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
# Source only (see .dockerignore): no .env files, no frontends, no tests or eval data.
COPY --chown=crewbrief:crewbrief packages ./packages
COPY --chown=crewbrief:crewbrief services ./services
COPY --chown=crewbrief:crewbrief knowledge ./knowledge
COPY --chown=crewbrief:crewbrief scripts/container_healthcheck.py ./scripts/container_healthcheck.py
# /app/var holds local-mode data (SQLite, submissions). A named volume mounted here
# inherits this ownership, so the non-root user can write to it.
RUN mkdir -p /app/var && chown crewbrief:crewbrief /app/var

USER 10001:10001
EXPOSE 8000 8001 8002 8003

HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
  CMD ["python", "/app/scripts/container_healthcheck.py", "/healthz"]

# exec so the Python process is PID 1 and receives SIGTERM for graceful shutdown.
CMD ["sh", "-c", "exec python -m \"services.${SERVICE}\""]
