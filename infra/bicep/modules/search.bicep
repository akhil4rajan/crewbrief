// Azure AI Search for the hazard & control library: semantic ranker, Entra ID only
// (local/key auth disabled), private endpoint.

import { roleAssignment } from 'types.bicep'

param location string
param tags object = {}
param name string
@allowed(['basic', 'standard', 'standard2'])
param skuName string = 'standard'
@minValue(1)
param replicaCount int = 1
param allowPublicNetworkAccess bool
param privateEndpointSubnetId string
param privateDnsZoneId string
param workspaceId string
param roleAssignments roleAssignment[] = []

resource search 'Microsoft.Search/searchServices@2023-11-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: skuName }
  identity: { type: 'SystemAssigned' }
  properties: {
    replicaCount: replicaCount
    partitionCount: 1
    hostingMode: 'default'
    semanticSearch: 'standard'
    disableLocalAuth: true
    publicNetworkAccess: allowPublicNetworkAccess ? 'enabled' : 'disabled'
    networkRuleSet: { ipRules: [] }
  }
}

resource roleGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in roleAssignments: {
  name: guid(search.id, r.principalId, r.roleDefinitionId)
  scope: search
  properties: {
    principalId: r.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', r.roleDefinitionId)
    principalType: r.?principalType ?? 'ServicePrincipal'
  }
}]

module privateEndpoint 'private-endpoint.bicep' = {
  name: '${name}-pe'
  params: {
    name: 'pe-${name}'
    location: location
    tags: tags
    subnetId: privateEndpointSubnetId
    targetResourceId: search.id
    groupId: 'searchService'
    privateDnsZoneIds: [privateDnsZoneId]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: search
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output name string = search.name
output endpoint string = 'https://${search.name}.search.windows.net'
