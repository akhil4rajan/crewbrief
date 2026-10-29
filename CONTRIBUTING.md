# Contributing

## Workflow

1. Branch from the latest `main`: `<type>/<short-description>` in lowercase kebab-case
   (`feature/user-login`, `fix/score-calculation`, `chore/update-readme`). One concern per branch.
2. Set up with `make setup`; run the stack with `make dev` (see `docs/runbooks/local-development.md`).
3. Before pushing: `make lint`, `make typecheck`, and `make eval` if you touched roles, prompts,
   schemas, rules or the hazard library.
4. Open a pull request using the template. CI runs lint, the eval gate, frontend builds, Bicep build,
   Docker build and a secret scan.

## Rules

- Changes to prompts, schemas or model deployments must include an eval run (`eval/run_eval.py`) and
  attach its report to the pull request.
- Safety rules live in code (`packages/rules`), not in prompts.
- Hazard and control codes are stable identifiers: never reuse or rename a code; add a new one.
- Record significant design decisions as an ADR in `docs/adr/` (see `docs/adr/index.md`).
- Never commit real credentials. `.env` holds dummy values only; use `.env.local`.
- Testing: verify behaviour by running the app or the eval; add focused tests only for bugs that are
  hard to verify otherwise.
