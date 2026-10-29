// CrewBrief Azure infrastructure (azd entry point).
//
//   azd provision        # uses main.parameters.json
//   az deployment sub create -l australiaeast -f infra/bicep/main.bicep -p environmentName=crewbrief-dev ...
//
// Everything lands in one resource group in Australia East (data residency). Services
// authenticate with per-service user-assigned managed identities; local/key auth is
// disabled on every data-plane resource that supports it, and data planes are reached over
// private endpoints. Outputs use the same names as .env.example so `azd env get-values`
// can populate .env.local.

targetScope = 'subscription'

import { roles } from 'modules/types.bicep'

// --- Environment ---------------------------------------------------------------

@minLength(1)
@maxLength(32)
@description('azd environment name, e.g. crewbrief-dev. Used for the resource group and tags.')
param environmentName string

@allowed(['australiaeast'])
@description('Data residency: all CrewBrief data and processing stay in Australia East.')
param location string = 'australiaeast'

@description('Object id of the person or pipeline running the deployment. Granted data-plane access for ingest and troubleshooting. Empty = none.')
param principalId string = ''

@allowed(['User', 'ServicePrincipal'])
param principalType string = 'User'

@description('Allow public network access to data planes. Keep false outside personal dev environments.')
param allowPublicNetworkAccess bool = false

@description('Zone redundancy for Container Apps, Cosmos DB and ACR. Recommended for prod.')
param zoneRedundant bool = false

@description('Application (client) id of the CrewBrief API app registration in Entra ID; users present tokens for it.')
param entraApiClientId string = ''

@description('Application (client) id of the review portal SPA registration (MSAL sign-in).')
param entraPortalClientId string = ''

@secure()
@description('Shared secret for /internal/* service calls. Stored in Key Vault, never in app settings.')
param internalServiceToken string

// --- Images (set by azd after the first deploy; empty = placeholder) -------------
param gatewayImage string = ''
param formApiImage string = ''
param orchestratorImage string = ''
param rolesImage string = ''
param reviewPortalImage string = ''

// --- Azure OpenAI (AI Services / Foundry) --------------------------------------
@allowed(['Standard', 'ProvisionedManaged'])
@description('Standard = regional pay-as-you-go. ProvisionedManaged = PTU for predictable latency at the morning peak. Global SKUs are not offered: they may process data outside Australia.')
param modelDeploymentSku string = 'Standard'
param extractorModel string = 'gpt-4.1-mini'
param extractorModelVersion string = '2025-04-14'
@description('Thousands of tokens/min for Standard; PTUs for ProvisionedManaged.')
param extractorCapacity int = 50
param verifierModel string = 'gpt-4.1'
param verifierModelVersion string = '2025-04-14'
param verifierCapacity int = 30

// --- Data ------------------------------------------------------------------------
@allowed(['basic', 'standard', 'standard2'])
param searchSku string = 'standard'
param searchReplicaCount int = 1
param searchIndexName string = 'hazards'

@allowed(['serverless', 'provisioned'])
param cosmosCapacityMode string = 'serverless'
param cosmosAutoscaleMaxThroughput int = 4000
@description('Encrypt Cosmos DB with a customer-managed key held in Key Vault.')
param cosmosCustomerManagedKey bool = false
param transcriptRetentionDays int = 90

@allowed(['Standard_S1', 'Premium_P1'])
param webPubSubSku string = 'Standard_S1'
@description('Web PubSub units; each unit carries 1,000 concurrent client connections.')
param webPubSubCapacity int = 1

@description('Optional blob storage for offline-buffered uploads and exports.')
param deployStorage bool = false

param logRetentionDays int = 90

// --- Scale -----------------------------------------------------------------------
param gatewayMinReplicas int = 2
param gatewayMaxReplicas int = 20
@description('Concurrent WebSocket connections (device + live) per gateway replica before scaling out.')
param gatewayConnectionsPerReplica int = 150
param formApiMinReplicas int = 2
param formApiMaxReplicas int = 10
@description('The orchestrator keeps per-session runners in memory. Keep max at 1 until session-affine routing is in place (see docs/runbooks/scaling-morning-peak.md).')
param orchestratorMinReplicas int = 1
param orchestratorMaxReplicas int = 1
param rolesMinReplicas int = 1
param rolesMaxReplicas int = 20

// --- Naming ----------------------------------------------------------------------
var token = toLower(uniqueString(subscription().id, environmentName, location))
var tags = {
  'azd-env-name': environmentName
  application: 'crewbrief'
  'data-classification': 'confidential'
  'data-residency': 'australia'
}
var workloads = ['gateway', 'form-api', 'orchestrator', 'roles', 'review-portal', 'ingest']
var identityWorkloads = cosmosCustomerManagedKey ? concat(workloads, ['cosmos-cmk']) : workloads
var appNames = {
  gateway: 'ca-gateway-${token}'
  formApi: 'ca-form-api-${token}'
  orchestrator: 'ca-orchestrator-${token}'
  roles: 'ca-roles-${token}'
  reviewPortal: 'ca-review-portal-${token}'
}
var aiServicesName = 'ais-${token}'
var deployerGrants = empty(principalId) ? [] : [principalId]

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

// --- Foundation --------------------------------------------------------------------

module monitoring 'modules/monitoring.bicep' = {
  scope: rg
  name: 'monitoring'
  params: {
    location: location
    tags: tags
    logAnalyticsName: 'log-${token}'
    appInsightsName: 'appi-${token}'
    retentionInDays: logRetentionDays
  }
}

module identities 'modules/identities.bicep' = {
  scope: rg
  name: 'identities'
  params: {
    location: location
    tags: tags
    namePrefix: 'id-${token}'
    workloads: identityWorkloads
  }
}

var ids = toObject(identities.outputs.identities, i => i.name)

module network 'modules/network.bicep' = {
  scope: rg
  name: 'network'
  params: {
    location: location
    tags: tags
    vnetName: 'vnet-${token}'
  }
}

module keyVault 'modules/keyvault.bicep' = {
  scope: rg
  name: 'keyvault'
  params: {
    location: location
    tags: tags
    name: 'kv-${token}'
    allowPublicNetworkAccess: allowPublicNetworkAccess
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.dnsZoneIds.keyVault
    workspaceId: monitoring.outputs.workspaceId
    internalServiceToken: internalServiceToken
    createCmkKey: cosmosCustomerManagedKey
    secretReaderPrincipalIds: [
      ids.gateway.principalId
      ids['form-api'].principalId
      ids.orchestrator.principalId
      ids.roles.principalId
    ]
    cryptoPrincipalIds: cosmosCustomerManagedKey ? [ids['cosmos-cmk'].principalId] : []
    extraRoleAssignments: map(deployerGrants, p => {
      principalId: p
      roleDefinitionId: roles.keyVaultSecretsOfficer
      principalType: principalType
    })
  }
}

module registry 'modules/registry.bicep' = {
  scope: rg
  name: 'registry'
  params: {
    location: location
    tags: tags
    name: 'cr${token}'
    allowPublicNetworkAccess: allowPublicNetworkAccess
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.dnsZoneIds.registry
    workspaceId: monitoring.outputs.workspaceId
    zoneRedundant: zoneRedundant
    pullPrincipalIds: map(workloads, w => ids[w].principalId)
  }
}

// --- AI services -------------------------------------------------------------------

module speech 'modules/cognitive-account.bicep' = {
  scope: rg
  name: 'speech'
  params: {
    location: location
    tags: tags
    name: 'spch-${token}'
    kind: 'SpeechServices'
    allowPublicNetworkAccess: allowPublicNetworkAccess
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneIds: [network.outputs.dnsZoneIds.cognitiveServices]
    workspaceId: monitoring.outputs.workspaceId
    // Transcription runs inside the gateway (ADR 0005).
    roleAssignments: concat(
      [{ principalId: ids.gateway.principalId, roleDefinitionId: roles.cognitiveServicesSpeechUser }],
      map(deployerGrants, p => { principalId: p, roleDefinitionId: roles.cognitiveServicesSpeechUser, principalType: principalType })
    )
  }
}

// AI Services (Foundry) account: hosts the extractor/verifier model deployments and Voice Live.
module aiServices 'modules/cognitive-account.bicep' = {
  scope: rg
  name: 'ai-services'
  params: {
    location: location
    tags: tags
    name: aiServicesName
    kind: 'AIServices'
    allowPublicNetworkAccess: allowPublicNetworkAccess
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneIds: [
      network.outputs.dnsZoneIds.cognitiveServices
      network.outputs.dnsZoneIds.openAi
      network.outputs.dnsZoneIds.aiServices
    ]
    workspaceId: monitoring.outputs.workspaceId
    roleAssignments: concat(
      [
        { principalId: ids.roles.principalId, roleDefinitionId: roles.cognitiveServicesOpenAIUser }
        // Voice Live (voice prompter) authorises with Cognitive Services User.
        { principalId: ids.roles.principalId, roleDefinitionId: roles.cognitiveServicesUser }
      ],
      map(deployerGrants, p => { principalId: p, roleDefinitionId: roles.cognitiveServicesOpenAIUser, principalType: principalType })
    )
  }
}

module modelDeployments 'modules/openai-deployments.bicep' = {
  scope: rg
  name: 'model-deployments'
  params: {
    accountName: aiServices.outputs.name
    deployments: [
      { name: 'extractor', model: extractorModel, version: extractorModelVersion, sku: modelDeploymentSku, capacity: extractorCapacity }
      { name: 'verifier', model: verifierModel, version: verifierModelVersion, sku: modelDeploymentSku, capacity: verifierCapacity }
    ]
  }
}

module language 'modules/cognitive-account.bicep' = {
  scope: rg
  name: 'language'
  params: {
    location: location
    tags: tags
    name: 'lang-${token}'
    kind: 'TextAnalytics'
    skuName: 'S'
    allowPublicNetworkAccess: allowPublicNetworkAccess
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneIds: [network.outputs.dnsZoneIds.cognitiveServices]
    workspaceId: monitoring.outputs.workspaceId
    // PII redaction runs in the gateway, before segments leave it (services/transcription).
    roleAssignments: [
      { principalId: ids.gateway.principalId, roleDefinitionId: roles.cognitiveServicesUser }
    ]
  }
}

// --- Data ------------------------------------------------------------------------

module search 'modules/search.bicep' = {
  scope: rg
  name: 'search'
  params: {
    location: location
    tags: tags
    name: 'srch-${token}'
    skuName: searchSku
    replicaCount: searchReplicaCount
    allowPublicNetworkAccess: allowPublicNetworkAccess
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.dnsZoneIds.search
    workspaceId: monitoring.outputs.workspaceId
    roleAssignments: concat(
      [
        { principalId: ids.roles.principalId, roleDefinitionId: roles.searchIndexDataReader }
        { principalId: ids.ingest.principalId, roleDefinitionId: roles.searchIndexDataContributor }
        { principalId: ids.ingest.principalId, roleDefinitionId: roles.searchServiceContributor }
      ],
      map(deployerGrants, p => { principalId: p, roleDefinitionId: roles.searchIndexDataContributor, principalType: principalType }),
      map(deployerGrants, p => { principalId: p, roleDefinitionId: roles.searchServiceContributor, principalType: principalType })
    )
  }
}

module cosmos 'modules/cosmos.bicep' = {
  scope: rg
  name: 'cosmos'
  params: {
    location: location
    tags: tags
    name: 'cosmos-${token}'
    capacityMode: cosmosCapacityMode
    autoscaleMaxThroughput: cosmosAutoscaleMaxThroughput
    transcriptRetentionDays: transcriptRetentionDays
    zoneRedundant: zoneRedundant
    allowPublicNetworkAccess: allowPublicNetworkAccess
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.dnsZoneIds.cosmos
    workspaceId: monitoring.outputs.workspaceId
    // Only the form API owns persistence (docs/api/contracts.md).
    dataContributorPrincipalIds: concat([ids['form-api'].principalId], deployerGrants)
    cmkKeyUri: keyVault.outputs.cmkKeyUri
    cmkIdentityId: cosmosCustomerManagedKey ? ids['cosmos-cmk'].id : ''
  }
}

module webPubSub 'modules/webpubsub.bicep' = {
  scope: rg
  name: 'webpubsub'
  params: {
    location: location
    tags: tags
    name: 'wps-${token}'
    skuName: webPubSubSku
    capacity: webPubSubCapacity
    hubName: 'crewbrief'
    allowPublicNetworkAccess: allowPublicNetworkAccess
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.dnsZoneIds.webPubSub
    workspaceId: monitoring.outputs.workspaceId
    // gateway: negotiate (client tokens); form-api + orchestrator: publish events.
    roleAssignments: [
      { principalId: ids.gateway.principalId, roleDefinitionId: roles.webPubSubServiceOwner }
      { principalId: ids['form-api'].principalId, roleDefinitionId: roles.webPubSubServiceOwner }
      { principalId: ids.orchestrator.principalId, roleDefinitionId: roles.webPubSubServiceOwner }
    ]
  }
}

module storage 'modules/storage.bicep' = if (deployStorage) {
  scope: rg
  name: 'storage'
  params: {
    location: location
    tags: tags
    name: 'st${token}'
    allowPublicNetworkAccess: allowPublicNetworkAccess
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.dnsZoneIds.blob
    workspaceId: monitoring.outputs.workspaceId
    roleAssignments: [
      { principalId: ids['form-api'].principalId, roleDefinitionId: roles.storageBlobDataContributor }
    ]
  }
}

// --- Compute -----------------------------------------------------------------------

module containerAppsEnv 'modules/container-apps-env.bicep' = {
  scope: rg
  name: 'container-apps-env'
  params: {
    location: location
    tags: tags
    name: 'cae-${token}'
    infrastructureSubnetId: network.outputs.containerAppsSubnetId
    logAnalyticsWorkspaceName: monitoring.outputs.workspaceName
    zoneRedundant: zoneRedundant
  }
}

var domain = containerAppsEnv.outputs.defaultDomain
var publicUrls = {
  gateway: 'https://${appNames.gateway}.${domain}'
  formApi: 'https://${appNames.formApi}.${domain}'
  reviewPortal: 'https://${appNames.reviewPortal}.${domain}'
}
// Service-to-service traffic uses the environment-internal FQDNs and never leaves the VNet.
var internalUrls = {
  gateway: 'https://${appNames.gateway}.internal.${domain}'
  formApi: 'https://${appNames.formApi}.internal.${domain}'
  orchestrator: 'https://${appNames.orchestrator}.internal.${domain}'
  roles: 'https://${appNames.roles}.internal.${domain}'
}

var backendEnv = [
  { name: 'CREWBRIEF_MODE', value: 'azure' }
  { name: 'CREWBRIEF_ENV', value: environmentName }
  { name: 'LOG_FORMAT', value: 'json' }
  { name: 'LOG_LEVEL', value: 'INFO' }
  { name: 'AUTH_MODE', value: 'entra' }
  { name: 'ENTRA_TENANT_ID', value: tenant().tenantId }
  { name: 'ENTRA_API_CLIENT_ID', value: entraApiClientId }
  { name: 'INTERNAL_SERVICE_TOKEN', secretRef: 'internal-service-token' }
  // Changes whenever the token changes, forcing a new revision so every replica picks it up together.
  { name: 'INTERNAL_TOKEN_REVISION', value: uniqueString(internalServiceToken) }
  { name: 'GATEWAY_URL', value: internalUrls.gateway }
  { name: 'FORM_API_URL', value: internalUrls.formApi }
  { name: 'ORCHESTRATOR_URL', value: internalUrls.orchestrator }
  { name: 'ROLES_URL', value: internalUrls.roles }
  { name: 'PUBLIC_GATEWAY_WS_URL', value: replace(publicUrls.gateway, 'https://', 'wss://') }
  { name: 'CORS_ORIGINS', value: publicUrls.reviewPortal }
  { name: 'AZURE_SPEECH_ENDPOINT', value: speech.outputs.endpoint }
  { name: 'AZURE_SPEECH_REGION', value: location }
  { name: 'AZURE_OPENAI_ENDPOINT', value: 'https://${aiServicesName}.openai.azure.com/' }
  { name: 'EXTRACTOR_DEPLOYMENT', value: 'extractor' }
  { name: 'VERIFIER_DEPLOYMENT', value: 'verifier' }
  { name: 'VOICE_LIVE_ENDPOINT', value: 'wss://${aiServicesName}.cognitiveservices.azure.com/voice-live/realtime' }
  { name: 'SEARCH_ENDPOINT', value: search.outputs.endpoint }
  { name: 'SEARCH_INDEX', value: searchIndexName }
  { name: 'COSMOS_ENDPOINT', value: cosmos.outputs.endpoint }
  { name: 'COSMOS_DATABASE', value: cosmos.outputs.databaseName }
  { name: 'WEBPUBSUB_ENDPOINT', value: webPubSub.outputs.endpoint }
  { name: 'WEBPUBSUB_HUB', value: webPubSub.outputs.hubName }
  { name: 'AZURE_LANGUAGE_ENDPOINT', value: language.outputs.endpoint }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: monitoring.outputs.appInsightsConnectionString }
  { name: 'RETAIN_RAW_AUDIO', value: 'false' }
  { name: 'PII_REDACTION', value: 'true' }
]
var tokenSecret = [{ name: 'internal-service-token', keyVaultUrl: keyVault.outputs.internalTokenSecretUri }]

func serviceEnv(base array, service string, clientId string) array =>
  concat(base, [{ name: 'SERVICE', value: service }, { name: 'AZURE_CLIENT_ID', value: clientId }])

module gatewayApp 'modules/container-app.bicep' = {
  scope: rg
  name: 'app-gateway'
  params: {
    location: location
    tags: tags
    environmentId: containerAppsEnv.outputs.id
    registryServer: registry.outputs.loginServer
    name: appNames.gateway
    azdServiceName: 'gateway'
    identityId: ids.gateway.id
    image: gatewayImage
    targetPort: 8000
    external: true
    cpu: '1.0'
    memory: '2Gi'
    env: serviceEnv(backendEnv, 'gateway', ids.gateway.clientId)
    keyVaultSecrets: tokenSecret
    minReplicas: gatewayMinReplicas
    maxReplicas: gatewayMaxReplicas
    concurrentRequests: gatewayConnectionsPerReplica
    scaleRuleName: 'websocket-connections'
  }
}

module formApiApp 'modules/container-app.bicep' = {
  scope: rg
  name: 'app-form-api'
  params: {
    location: location
    tags: tags
    environmentId: containerAppsEnv.outputs.id
    registryServer: registry.outputs.loginServer
    name: appNames.formApi
    azdServiceName: 'form-api'
    identityId: ids['form-api'].id
    image: formApiImage
    targetPort: 8001
    external: true
    env: serviceEnv(backendEnv, 'form_api', ids['form-api'].clientId)
    keyVaultSecrets: tokenSecret
    minReplicas: formApiMinReplicas
    maxReplicas: formApiMaxReplicas
    concurrentRequests: 80
  }
}

module orchestratorApp 'modules/container-app.bicep' = {
  scope: rg
  name: 'app-orchestrator'
  params: {
    location: location
    tags: tags
    environmentId: containerAppsEnv.outputs.id
    registryServer: registry.outputs.loginServer
    name: appNames.orchestrator
    azdServiceName: 'orchestrator'
    identityId: ids.orchestrator.id
    image: orchestratorImage
    targetPort: 8002
    external: false
    cpu: '1.0'
    memory: '2Gi'
    env: serviceEnv(backendEnv, 'orchestrator', ids.orchestrator.clientId)
    keyVaultSecrets: tokenSecret
    minReplicas: orchestratorMinReplicas
    maxReplicas: orchestratorMaxReplicas
    concurrentRequests: 200
  }
}

module rolesApp 'modules/container-app.bicep' = {
  scope: rg
  name: 'app-roles'
  params: {
    location: location
    tags: tags
    environmentId: containerAppsEnv.outputs.id
    registryServer: registry.outputs.loginServer
    name: appNames.roles
    azdServiceName: 'roles'
    identityId: ids.roles.id
    image: rolesImage
    targetPort: 8003
    external: false
    env: serviceEnv(backendEnv, 'roles', ids.roles.clientId)
    keyVaultSecrets: tokenSecret
    minReplicas: rolesMinReplicas
    maxReplicas: rolesMaxReplicas
    // LLM calls are I/O bound but slow; scale before queues build up.
    concurrentRequests: 20
  }
}

module reviewPortalApp 'modules/container-app.bicep' = {
  scope: rg
  name: 'app-review-portal'
  params: {
    location: location
    tags: tags
    environmentId: containerAppsEnv.outputs.id
    registryServer: registry.outputs.loginServer
    name: appNames.reviewPortal
    azdServiceName: 'review-portal'
    identityId: ids['review-portal'].id
    image: reviewPortalImage
    // Unprivileged nginx; the entrypoint writes /config.js from VITE_* at start-up.
    targetPort: 8080
    external: true
    cpu: '0.25'
    memory: '0.5Gi'
    env: [
      { name: 'VITE_API_BASE_URL', value: publicUrls.formApi }
      { name: 'VITE_GATEWAY_URL', value: publicUrls.gateway }
      { name: 'VITE_AUTH_MODE', value: 'entra' }
      { name: 'VITE_ENTRA_CLIENT_ID', value: entraPortalClientId }
      { name: 'VITE_ENTRA_AUTHORITY', value: '${environment().authentication.loginEndpoint}${tenant().tenantId}' }
      { name: 'VITE_ENTRA_SCOPES', value: empty(entraApiClientId) ? '' : 'api://${entraApiClientId}/access_as_user' }
      { name: 'VITE_SIMULATOR', value: 'off' }
      { name: 'CSP_CONNECT_EXTRA', value: 'wss://${webPubSub.outputs.name}.webpubsub.azure.com' }
    ]
    minReplicas: 1
    maxReplicas: 5
    concurrentRequests: 100
    livenessPath: '/healthz'
    readinessPath: '/healthz'
  }
}

module ingestJob 'modules/ingest-job.bicep' = {
  scope: rg
  name: 'ingest-job'
  params: {
    location: location
    tags: tags
    name: 'caj-ingest-${token}'
    environmentId: containerAppsEnv.outputs.id
    identityId: ids.ingest.id
    registryServer: registry.outputs.loginServer
    // Same backend image as the services.
    image: gatewayImage
    env: [
      { name: 'CREWBRIEF_MODE', value: 'azure' }
      { name: 'CREWBRIEF_ENV', value: environmentName }
      { name: 'LOG_FORMAT', value: 'json' }
      { name: 'AZURE_CLIENT_ID', value: ids.ingest.clientId }
      { name: 'SEARCH_ENDPOINT', value: search.outputs.endpoint }
      { name: 'SEARCH_INDEX', value: searchIndexName }
      { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: monitoring.outputs.appInsightsConnectionString }
    ]
  }
}

// --- Outputs (names match .env.example; azd stores them in the environment) --------------

output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.outputs.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = registry.outputs.name
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = containerAppsEnv.outputs.name
output AZURE_KEY_VAULT_NAME string = keyVault.outputs.name
output AZURE_KEY_VAULT_ENDPOINT string = keyVault.outputs.uri
output AZURE_INGEST_JOB_NAME string = ingestJob.outputs.name

output AZURE_SPEECH_ENDPOINT string = speech.outputs.endpoint
output AZURE_SPEECH_REGION string = location
output AZURE_OPENAI_ENDPOINT string = 'https://${aiServicesName}.openai.azure.com/'
output EXTRACTOR_DEPLOYMENT string = 'extractor'
output VERIFIER_DEPLOYMENT string = 'verifier'
output VOICE_LIVE_ENDPOINT string = 'wss://${aiServicesName}.cognitiveservices.azure.com/voice-live/realtime'
output SEARCH_ENDPOINT string = search.outputs.endpoint
output SEARCH_INDEX string = searchIndexName
output COSMOS_ENDPOINT string = cosmos.outputs.endpoint
output COSMOS_DATABASE string = cosmos.outputs.databaseName
output WEBPUBSUB_ENDPOINT string = webPubSub.outputs.endpoint
output WEBPUBSUB_HUB string = webPubSub.outputs.hubName
output AZURE_LANGUAGE_ENDPOINT string = language.outputs.endpoint
output APPLICATIONINSIGHTS_CONNECTION_STRING string = monitoring.outputs.appInsightsConnectionString
output AZURE_STORAGE_BLOB_ENDPOINT string = deployStorage ? storage!.outputs.blobEndpoint : ''

// Public URLs. Deliberately not named GATEWAY_URL/FORM_API_URL so that copying these values
// into .env.local does not repoint a local stack at Azure.
output AZURE_GATEWAY_URL string = publicUrls.gateway
output AZURE_FORM_API_URL string = publicUrls.formApi
output AZURE_REVIEW_PORTAL_URL string = publicUrls.reviewPortal
