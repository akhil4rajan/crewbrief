// Key Vault (RBAC, soft delete + purge protection, private endpoint) holding the internal
// service token and, optionally, the customer-managed key for Cosmos DB.

import { roleAssignment, roles } from 'types.bicep'

param location string
param tags object = {}
param name string
param allowPublicNetworkAccess bool
param privateEndpointSubnetId string
param privateDnsZoneId string
param workspaceId string

@secure()
@description('Shared secret for /internal/* calls between services.')
param internalServiceToken string

@description('Create an RSA key for Cosmos DB customer-managed encryption.')
param createCmkKey bool = false
@description('Principals that read secrets (Key Vault Secrets User).')
param secretReaderPrincipalIds array = []
@description('Principals that use the CMK key (Key Vault Crypto Service Encryption User).')
param cryptoPrincipalIds array = []
param extraRoleAssignments roleAssignment[] = []

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      // AzureServices bypass lets Cosmos DB reach the CMK key through the firewall.
      bypass: 'AzureServices'
      defaultAction: allowPublicNetworkAccess ? 'Allow' : 'Deny'
    }
  }
}

resource internalToken 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'internal-service-token'
  properties: {
    value: internalServiceToken
    contentType: 'text/plain'
  }
}

resource cmkKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = if (createCmkKey) {
  parent: vault
  name: 'cosmos-cmk'
  properties: {
    kty: 'RSA'
    keySize: 3072
    keyOps: ['wrapKey', 'unwrapKey']
    rotationPolicy: {
      attributes: { expiryTime: 'P2Y' }
      lifetimeActions: [
        {
          trigger: { timeBeforeExpiry: 'P30D' }
          action: { type: 'rotate' }
        }
      ]
    }
  }
}

var assignments = concat(
  map(secretReaderPrincipalIds, p => { principalId: p, roleDefinitionId: roles.keyVaultSecretsUser }),
  map(cryptoPrincipalIds, p => { principalId: p, roleDefinitionId: roles.keyVaultCryptoServiceEncryptionUser }),
  extraRoleAssignments
)

resource roleGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in assignments: {
  name: guid(vault.id, r.principalId, r.roleDefinitionId)
  scope: vault
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
    targetResourceId: vault.id
    groupId: 'vault'
    privateDnsZoneIds: [privateDnsZoneId]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: vault
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output name string = vault.name
output uri string = vault.properties.vaultUri
output internalTokenSecretUri string = internalToken.properties.secretUri
output cmkKeyUri string = createCmkKey ? '${vault.properties.vaultUri}keys/${cmkKey.name}' : ''
