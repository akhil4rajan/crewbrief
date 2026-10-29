# CrewBrief developer tasks. Run `make help` for the list.
# Everything runs from the repo root so `packages.*`, `services.*`, `knowledge.*`
# and `eval.*` import without installing anything globally.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

VENV        ?= .venv
PYTHON      ?= $(VENV)/bin/python
UV          ?= uv
NPM         ?= npm
FRONTENDS   := apps/review-portal apps/mobile
EVAL_DATASET ?= eval/datasets/sample_v1
EVAL_REPORT  ?= eval/reports/
REPLAY_SCRIPT ?= samples/briefing_01.json
BICEP_MAIN  := infra/bicep/main.bicep

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n\n"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- Setup --------------------------------------------------------------------

.PHONY: setup
setup: ## Create .venv, install Python deps (dev) and frontend deps
	@test -d $(VENV) || $(UV) venv $(VENV) --python 3.12
	$(UV) pip install --python $(PYTHON) -e '.[dev]'
	@for app in $(FRONTENDS); do \
	  if [ -f $$app/package.json ]; then \
	    echo "==> $$app"; \
	    if [ -f $$app/package-lock.json ]; then $(NPM) --prefix $$app ci; else $(NPM) --prefix $$app install; fi; \
	  fi; \
	done
	@command -v pre-commit >/dev/null && pre-commit install || echo "tip: 'uv tool install pre-commit && pre-commit install' enables the git hooks"

.PHONY: setup-azure
setup-azure: ## Also install the Azure SDKs (needed for CREWBRIEF_MODE=azure)
	$(UV) pip install --python $(PYTHON) -e '.[dev,azure]'

.PHONY: check-env
check-env: ## Report which integrations are local/dummy vs real (never prints secrets)
	$(PYTHON) scripts/check_env.py

# --- Run ----------------------------------------------------------------------

.PHONY: dev
dev: ## Run all four services with reload + review portal (Ctrl-C stops all)
	./scripts/dev.sh

.PHONY: ingest
ingest: ## Build the local hazard knowledge index
	$(PYTHON) -m knowledge.ingest --target local

.PHONY: replay
replay: ## Replay a scripted briefing against the running stack
	$(PYTHON) -m services.gateway.tools.replay --script $(REPLAY_SCRIPT)

.PHONY: schemas
schemas: ## Export JSON Schema for the TypeScript clients
	$(PYTHON) -m packages.schemas.export

# --- Quality ------------------------------------------------------------------

.PHONY: eval
eval: ## Run the offline eval and write a report
	$(PYTHON) eval/run_eval.py --dataset $(EVAL_DATASET) --report $(EVAL_REPORT)

.PHONY: lint
lint: ## Ruff (Python) + frontend linters
	$(VENV)/bin/ruff check .
	@for app in $(FRONTENDS); do \
	  if [ -f $$app/package.json ]; then $(NPM) --prefix $$app run lint --if-present; fi; \
	done

.PHONY: format
format: ## Auto-fix lint issues
	$(VENV)/bin/ruff check --fix .

.PHONY: typecheck
typecheck: ## mypy (Python) + tsc (frontends)
	$(VENV)/bin/mypy packages services knowledge
	@for app in $(FRONTENDS); do \
	  if [ -f $$app/package.json ]; then $(NPM) --prefix $$app run typecheck --if-present; fi; \
	done

.PHONY: bicep
bicep: ## Compile the Bicep templates (needs az CLI or bicep)
	@if command -v bicep >/dev/null; then bicep build $(BICEP_MAIN) --stdout >/dev/null; \
	else az bicep build --file $(BICEP_MAIN) --stdout >/dev/null; fi
	@echo "bicep: OK"

# --- Containers ---------------------------------------------------------------

.PHONY: compose-up
compose-up: ## Build and start the stack in Docker
	docker compose up --build

.PHONY: compose-down
compose-down: ## Stop the Docker stack (keeps the data volume)
	docker compose down

.PHONY: clean
clean: ## Remove caches and local data (./var)
	rm -rf var .ruff_cache .mypy_cache .pytest_cache
	find . -name __pycache__ -type d -prune -not -path './node_modules/*' -exec rm -rf {} +
