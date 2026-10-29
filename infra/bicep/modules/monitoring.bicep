// Log Analytics workspace (all diagnostics land here) and workspace-based Application Insights.

param location string
param tags object = {}
param logAnalyticsName string
param appInsightsName string
@minValue(30)
param retentionInDays int = 90

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionInDays
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    // Transcripts may contain personal information: never collect request bodies or IPs.
    DisableIpMasking: false
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output appInsightsConnectionString string = appInsights.properties.ConnectionString
