// Generic Azure AI services account (Speech, Language, AI Services/Foundry): custom subdomain
// (required for Entra ID auth), local (key) auth disabled, private endpoint, diagnostics, RBAC.

import { roleAssignment } from 'types.bicep'

param location string
param tags object = {}
param name string
@allowed(['SpeechServices', 'TextAnalytics', 'AIServices', 'OpenAI'])
param kind string
param skuName string = 'S0'
param allowPublicNetworkAccess bool
param privateEndpointSubnetId string
param privateDnsZoneIds array
param workspaceId string
param roleAssignments roleAssignment[] = []

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: name
  location: location
  tags: tags
  kind: kind
  sku: { name: skuName }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: name
    disableLocalAuth: true
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      defaultAction: allowPublicNetworkAccess ? 'Allow' : 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource roleGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in roleAssignments: {
  name: guid(account.id, r.principalId, r.roleDefinitionId)
  scope: account
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
    targetResourceId: account.id
    groupId: 'account'
    privateDnsZoneIds: privateDnsZoneIds
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: account
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output id string = account.id
output name string = account.name
output endpoint string = account.properties.endpoint
@description('Custom subdomain host, e.g. <name>.cognitiveservices.azure.com.')
output subdomain string = name
