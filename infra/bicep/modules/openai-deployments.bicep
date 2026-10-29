// Model deployments on the AI Services (Foundry) account. Deployed one at a time: the
// resource provider rejects concurrent deployment operations on one account.

param accountName string

@description('[{ name, model, version, sku, capacity }]. sku: Standard (regional, pay-as-you-go) or ProvisionedManaged (PTU).')
param deployments array

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: accountName
}

@batchSize(1)
resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [for d in deployments: {
  parent: account
  name: d.name
  sku: {
    name: d.sku
    capacity: d.capacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: d.model
      version: d.version
    }
    versionUpgradeOption: 'NoAutoUpgrade'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}]

output names array = [for (d, i) in deployments: deployment[i].name]
