// Azure Container Registry. Premium is required for private endpoints; admin user is disabled,
// so workloads pull with their managed identity (AcrPull).

import { roles } from 'types.bicep'

param location string
param tags object = {}
param name string
param allowPublicNetworkAccess bool
param privateEndpointSubnetId string
param privateDnsZoneId string
param workspaceId string
param pullPrincipalIds array = []
param zoneRedundant bool = false

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: 'Premium' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkRuleBypassOptions: 'AzureServices'
    zoneRedundancy: zoneRedundant ? 'Enabled' : 'Disabled'
    policies: {
      retentionPolicy: { days: 30, status: 'enabled' }
    }
  }
}

resource pullGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for p in pullPrincipalIds: {
  name: guid(registry.id, p, roles.acrPull)
  scope: registry
  properties: {
    principalId: p
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
    principalType: 'ServicePrincipal'
  }
}]

module privateEndpoint 'private-endpoint.bicep' = {
  name: '${name}-pe'
  params: {
    name: 'pe-${name}'
    location: location
    tags: tags
    subnetId: privateEndpointSubnetId
    targetResourceId: registry.id
    groupId: 'registry'
    privateDnsZoneIds: [privateDnsZoneId]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: registry
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output name string = registry.name
output loginServer string = registry.properties.loginServer
