// VNet-integrated Container Apps environment (workload profiles, consumption). The
// environment itself is external so the gateway, form API and portal can take internet
// traffic; orchestrator and roles use internal-only ingress and are unreachable from outside.

param location string
param tags object = {}
param name string
param infrastructureSubnetId string
param logAnalyticsWorkspaceName string
param zoneRedundant bool = false

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      internal: false
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
    zoneRedundant: zoneRedundant
    peerTrafficConfiguration: {
      encryption: { enabled: true }
    }
  }
}

output id string = environment.id
output name string = environment.name
output defaultDomain string = environment.properties.defaultDomain
