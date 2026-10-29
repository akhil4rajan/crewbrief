# Runbook: deploy to Azure

Infrastructure is Bicep (`infra/bicep`), driven by the Azure Developer CLI. azd requires its
project file at the repository root, so the project file is `azure.yaml` at the root and points
`infra.path` at `infra/bicep`; `infra/azure.yaml` is only a pointer to it. Run azd from the root.

## What gets created

One resource group `rg-<env>` in Australia East (the only allowed `location`): Log Analytics +
Application Insights, a VNet with private DNS zones, Key Vault, Container Registry (Premium),
Container Apps environment with five apps and an ingest job, AI Speech, AI Services (Azure
OpenAI deployments `extractor` and `verifier`, Voice Live), AI Language, AI Search, Cosmos DB,
Web PubSub, and optionally blob storage. Each workload has its own managed identity.

## One-time setup

1. **Entra app registrations** (not created by Bicep):
   - *CrewBrief API*: expose scope `access_as_user`, app roles `crew`, `supervisor`,
     `safety_admin`. Its client id is `ENTRA_API_CLIENT_ID`.
   - *CrewBrief web app*: SPA platform with the portal URL as redirect URI, permission
     to the API scope. Its client id is `ENTRA_PORTAL_CLIENT_ID`. Crew and supervisors use the
     same app; the `roles` claim decides which view they land on.
2. **Quota**: confirm regional Standard (or PTU) quota in Australia East for the models in
   `main.bicep` (`extractorModel`, `verifierModel`). Override the model and version parameters
   if a model is not offered regionally. Global deployment types are deliberately not allowed.
3. **Deployment identity for CI**: an Entra app with a federated credential for
   `repo:<owner>/crewbrief:environment:<dev|prod>`, granted *Owner* (or *Contributor* +
   *Role Based Access Control Administrator*) on the subscription, because the templates create
   role assignments. Store `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and
   `AZURE_ENV_NAME` as GitHub **environment variables** (not secrets; nothing secret is needed).

## Manual deploy (personal dev environment)

```bash
azd auth login
azd env new crewbrief-dev
azd env set AZURE_LOCATION australiaeast
azd env set AZURE_PRINCIPAL_ID "$(az ad signed-in-user show --query id -o tsv)"
azd env set ENTRA_API_CLIENT_ID <api-client-id>
azd env set ENTRA_PORTAL_CLIENT_ID <portal-client-id>
azd env set ALLOW_PUBLIC_NETWORK_ACCESS true    # personal dev only: lets your laptop reach data planes and ACR
azd up                                          # provision + build + deploy
```

The first provision runs a public placeholder image (no probes) until azd pushes the real
images; later provisions reuse `SERVICE_<NAME>_IMAGE_NAME` from the azd environment.

## CI/CD

`.github/workflows/deploy.yml` runs on pushes to `main` and on demand (`workflow_dispatch`,
choose `dev` or `prod`). It logs in with OIDC, runs `azd provision` then `azd deploy --all`,
and optionally reloads the hazard library. Protect the `prod` GitHub environment with required
reviewers. Branch protection on `main` should require the CI workflow, so only changes that
passed the eval gate are deployed.

**Network caveat**: with `ALLOW_PUBLIC_NETWORK_ACCESS=false`, ACR has no public endpoint, so a
GitHub-hosted runner cannot push images. For locked-down environments use a self-hosted runner
inside (or peered with) the VNet, or an ACR agent pool. Do not flip the flag on for production.

## Load the hazard library

AI Search is private, so ingest runs inside the environment as a Container Apps job:

```bash
rg=$(azd env get-value AZURE_RESOURCE_GROUP); job=$(azd env get-value AZURE_INGEST_JOB_NAME)
az containerapp job update -g "$rg" -n "$job" --image "$(azd env get-value SERVICE_GATEWAY_IMAGE_NAME)" \
  --command python -m knowledge.ingest --target azure
az containerapp job start -g "$rg" -n "$job"
az containerapp job execution list -g "$rg" -n "$job" -o table
```

Or tick *run_ingest* when running the deploy workflow.

## Verify

```bash
curl -fsS "$(azd env get-value AZURE_GATEWAY_URL)/healthz"
curl -fsS "$(azd env get-value AZURE_FORM_API_URL)/readyz"
```

Then open `AZURE_REVIEW_PORTAL_URL`, sign in, and run a briefing as a crew user (crew view at `/crew`).
Check Application Insights → Failures and Live metrics.

## Rollback

Container Apps run in single-revision mode. To roll back an app, reactivate the previous revision:

```bash
az containerapp revision list -g "$rg" -n <app> -o table
az containerapp ingress traffic set -g "$rg" -n <app> --revision-weight <previous-revision>=100
```

or redeploy the previous commit through the workflow. Infrastructure changes roll back by
reverting the Bicep change and re-running provision. Cosmos DB has continuous backup (7 days)
for point-in-time restore.

## Internal service token

`internalServiceToken` comes from azd's `secretOrRandomPassword`: it reuses the Key Vault
secret when azd can read it and generates a new one otherwise (e.g. from a runner outside the
VNet). The apps carry a fingerprint of the token (`INTERNAL_TOKEN_REVISION`), so a new token
always rolls every backend app to a new revision together. See `secret-rotation.md`.
