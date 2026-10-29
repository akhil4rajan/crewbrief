// Optional blob storage (off by default): reserved for offline-buffered session uploads and
// exports. Shared-key access disabled, private endpoint, no public blob access.

import { roleAssignment } from 'types.bicep'

param location string
param tags object = {}
param name string
param allowPublicNetworkAccess bool
param privateEndpointSubnetId string
param privateDnsZoneId string
param workspaceId string
param roleAssignments roleAssignment[] = []

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_ZRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: allowPublicNetworkAccess ? 'Allow' : 'Deny'
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: { blob: { enabled: true } }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource roleGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in roleAssignments: {
  name: guid(storage.id, r.principalId, r.roleDefinitionId)
  scope: storage
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
    targetResourceId: storage.id
    groupId: 'blob'
    privateDnsZoneIds: [privateDnsZoneId]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: blobService
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'Transaction', enabled: true }]
  }
}

output name string = storage.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob
