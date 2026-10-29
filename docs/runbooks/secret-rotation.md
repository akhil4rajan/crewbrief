# Runbook: secret and credential rotation

CrewBrief in Azure has almost nothing to rotate: services authenticate with managed identities
and local (key) auth is disabled on Speech, OpenAI, Language, Search, Cosmos DB and Web PubSub.
What remains:

| Credential | Where | Rotation |
|---|---|---|
| Internal service token (`/internal/*`) | Key Vault secret `internal-service-token`, referenced by the container apps | Below; at least every 90 days and on suspicion |
| Cosmos DB CMK (if enabled) | Key Vault key `cosmos-cmk` | Automatic rotation policy (2 years, rotate 30 days before expiry); Cosmos follows the versionless key URI |
| GitHub → Azure deploy identity | Federated credential (OIDC) | Nothing to rotate; review the subject claims and role assignments quarterly |
| Entra app registrations | No client secrets (SPA/public clients, managed identity) | Nothing to rotate |
| Local `.env.local` keys | Developers' laptops only | Regenerate in the portal if a laptop is lost; never used in Azure |

## Rotate the internal service token

The token must change on every backend app at the same time. The Bicep templates carry a
fingerprint of the token on each app (`INTERNAL_TOKEN_REVISION`), so a provision with a new
token rolls all four apps to new revisions together.

```bash
# from a machine that can reach Key Vault (inside the VNet, or a dev env with public access)
kv=$(azd env get-value AZURE_KEY_VAULT_NAME)
az keyvault secret set --vault-name "$kv" -n internal-service-token \
  --value "$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" -o none
azd provision --no-prompt     # azd reads the new value (secretOrRandomPassword) and rolls the apps
```

If you cannot run azd, restart every backend app so new replicas resolve the new secret:

```bash
for app in gateway form-api orchestrator roles; do
  name=$(az containerapp list -g "$rg" --query "[?tags.\"azd-service-name\"=='$app'].name" -o tsv)
  az containerapp revision restart -g "$rg" -n "$name" \
    --revision "$(az containerapp revision list -g "$rg" -n "$name" --query '[?properties.active].name | [0]' -o tsv)"
done
```

Expect a few seconds of 401s on `/internal/*` while revisions switch; the internal HTTP
client retries, and event publishing is best-effort.

## Suspected leak of any key

1. Keys should not exist (local auth is disabled). If one does, find out why: `az resource show`
   and check `disableLocalAuth`. Re-enable the setting through Bicep and re-provision.
2. Regenerate the key in the resource (`az cognitiveservices account keys regenerate`, etc.).
3. Purge it from git history if it was committed, and confirm gitleaks catches the pattern.
4. Review Log Analytics for use of the key in the exposure window.
