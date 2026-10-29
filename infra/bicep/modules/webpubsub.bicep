// Azure Web PubSub fans out live form patches to the crew app and review portal.
// Clients connect over the public endpoint with short-lived tokens from the gateway's
// negotiate endpoint; server-side REST and server connections are allowed only through
// the private endpoint. Local (key) auth is disabled: services use managed identity.

import { roleAssignment } from 'types.bicep'

param location string
param tags object = {}
param name string
@allowed(['Standard_S1', 'Premium_P1'])
param skuName string = 'Standard_S1'
@minValue(1)
param capacity int = 1
param hubName string = 'crewbrief'
param allowPublicNetworkAccess bool
param privateEndpointSubnetId string
param privateDnsZoneId string
param workspaceId string
param roleAssignments roleAssignment[] = []

resource pubsub 'Microsoft.SignalRService/webPubSub@2024-03-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: skuName, capacity: capacity }
  identity: { type: 'SystemAssigned' }
  properties: {
    disableLocalAuth: true
    disableAadAuth: false
    // Public access stays on for ClientConnection only (devices and browsers on the internet).
    publicNetworkAccess: 'Enabled'
    networkACLs: {
      defaultAction: 'Allow'
      publicNetwork: allowPublicNetworkAccess ? {} : { deny: ['RESTAPI', 'ServerConnection', 'Trace'] }
    }
    tls: { clientCertEnabled: false }
  }
}

resource hub 'Microsoft.SignalRService/webPubSub/hubs@2024-03-01' = {
  parent: pubsub
  name: hubName
  properties: {
    // Clients are read-only subscribers; no anonymous connections and no upstream handlers.
    anonymousConnectPolicy: 'deny'
    eventHandlers: []
  }
}

resource roleGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in roleAssignments: {
  name: guid(pubsub.id, r.principalId, r.roleDefinitionId)
  scope: pubsub
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
    targetResourceId: pubsub.id
    groupId: 'webpubsub'
    privateDnsZoneIds: [privateDnsZoneId]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: pubsub
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output name string = pubsub.name
output endpoint string = 'https://${pubsub.properties.hostName}'
output hubName string = hub.name
