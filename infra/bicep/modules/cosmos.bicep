// Cosmos DB (NoSQL) for sessions, drafts, transcript segments, gaps and audit. Entra ID only
// (local auth disabled), private endpoint, continuous backup, optional customer-managed key.
// Every container is partitioned by /session_id: all reads/writes on the hot path are per session.

import { cosmosDataContributorRoleId } from 'types.bicep'

param location string
param tags object = {}
param name string
param databaseName string = 'crewbrief'
@allowed(['serverless', 'provisioned'])
param capacityMode string = 'serverless'
@description('Autoscale max RU/s for the shared database throughput (provisioned mode only).')
param autoscaleMaxThroughput int = 4000
@description('Must match services/form_api/store/cosmos.py CONTAINERS: with Entra-only auth the app cannot create containers.')
param containerNames array = ['sessions', 'drafts', 'draft_revisions', 'segments', 'gaps', 'audit', 'tombstones']
@description('Transcript segments expire after this many days (data minimisation). 0 = never.')
param transcriptRetentionDays int = 90
param zoneRedundant bool = false
param allowPublicNetworkAccess bool
param privateEndpointSubnetId string
param privateDnsZoneId string
param workspaceId string
@description('Principals granted Cosmos DB Built-in Data Contributor on the database.')
param dataContributorPrincipalIds array = []

@description('Versionless Key Vault key URI for customer-managed encryption. Empty = Microsoft-managed keys.')
param cmkKeyUri string = ''
@description('Resource id of the user-assigned identity that can unwrap the CMK key.')
param cmkIdentityId string = ''

var useCmk = !empty(cmkKeyUri)
var transcriptsContainer = 'segments'

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: name
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  identity: useCmk ? { type: 'UserAssigned', userAssignedIdentities: { '${cmkIdentityId}': {} } } : { type: 'None' }
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: zoneRedundant }]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    capabilities: capacityMode == 'serverless' ? [{ name: 'EnableServerless' }] : []
    disableLocalAuth: true
    disableKeyBasedMetadataWriteAccess: true
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAclBypass: 'None'
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: { tier: 'Continuous7Days' }
    }
    keyVaultKeyUri: useCmk ? cmkKeyUri : null
    defaultIdentity: useCmk ? 'UserAssignedIdentity=${cmkIdentityId}' : 'FirstPartyIdentity'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: { id: databaseName }
    options: capacityMode == 'provisioned' ? { autoscaleSettings: { maxThroughput: autoscaleMaxThroughput } } : {}
  }
}

resource containers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = [for c in containerNames: {
  parent: database
  name: c
  properties: {
    resource: union(
      {
        id: c
        partitionKey: { paths: ['/session_id'], kind: 'Hash', version: 2 }
        indexingPolicy: {
          indexingMode: 'consistent'
          includedPaths: [{ path: '/*' }]
          excludedPaths: [{ path: '/"_etag"/?' }]
        }
      },
      c == transcriptsContainer && transcriptRetentionDays > 0 ? { defaultTtl: transcriptRetentionDays * 86400 } : {}
    )
  }
}]

// Data-plane RBAC is scoped to the database, not the account.
resource dataGrants 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = [for p in dataContributorPrincipalIds: {
  parent: account
  name: guid(account.id, p, cosmosDataContributorRoleId)
  properties: {
    principalId: p
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    scope: '${account.id}/dbs/${databaseName}'
  }
  dependsOn: [database]
}]

module privateEndpoint 'private-endpoint.bicep' = {
  name: '${name}-pe'
  params: {
    name: 'pe-${name}'
    location: location
    tags: tags
    subnetId: privateEndpointSubnetId
    targetResourceId: account.id
    groupId: 'Sql'
    privateDnsZoneIds: [privateDnsZoneId]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: account
  properties: {
    workspaceId: workspaceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'Requests', enabled: true }]
  }
}

output name string = account.name
output endpoint string = account.properties.documentEndpoint
output databaseName string = database.name
