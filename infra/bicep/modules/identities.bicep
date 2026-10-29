// One user-assigned managed identity per workload, so each gets only the roles it needs.

param location string
param tags object = {}
param namePrefix string
@description('Workload names, e.g. gateway, form-api.')
param workloads array

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for w in workloads: {
  name: '${namePrefix}-${w}'
  location: location
  tags: tags
}]

@description('One entry per workload: { name, id, principalId, clientId }.')
output identities array = [for (w, i) in workloads: {
  name: w
  id: identity[i].id
  principalId: identity[i].properties.principalId
  clientId: identity[i].properties.clientId
}]
