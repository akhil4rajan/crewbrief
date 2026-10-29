// VNet with a delegated subnet for the Container Apps environment and a subnet for private
// endpoints, plus the private DNS zones those endpoints register in.

param location string
param tags object = {}
param vnetName string
param addressPrefix string = '10.40.0.0/16'
@description('Container Apps infrastructure subnet. /23 or larger leaves room to scale.')
param containerAppsSubnetPrefix string = '10.40.0.0/23'
param privateEndpointSubnetPrefix string = '10.40.2.0/24'

// Order matters: outputs below index into this list.
var privateDnsZoneNames = [
  'privatelink.vaultcore.azure.net' // 0 Key Vault
  'privatelink.azurecr.io' // 1 Container Registry
  'privatelink.cognitiveservices.azure.com' // 2 Speech, Language, AI Services
  'privatelink.openai.azure.com' // 3 Azure OpenAI endpoint of the AI Services account
  'privatelink.services.ai.azure.com' // 4 AI Services (Foundry) endpoint
  'privatelink.search.windows.net' // 5 AI Search
  'privatelink.documents.azure.com' // 6 Cosmos DB (NoSQL)
  'privatelink.webpubsub.azure.com' // 7 Web PubSub
  'privatelink.blob.${environment().suffixes.storage}' // 8 Storage (blob)
]

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'snet-container-apps'
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          delegations: [
            {
              name: 'container-apps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource zones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for zone in privateDnsZoneNames: {
  name: zone
  location: 'global'
  tags: tags
}]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (zone, i) in privateDnsZoneNames: {
  parent: zones[i]
  name: '${vnetName}-link'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}]

output vnetId string = vnet.id
output containerAppsSubnetId string = vnet.properties.subnets[0].id
output privateEndpointSubnetId string = vnet.properties.subnets[1].id
output dnsZoneIds object = {
  keyVault: zones[0].id
  registry: zones[1].id
  cognitiveServices: zones[2].id
  openAi: zones[3].id
  aiServices: zones[4].id
  search: zones[5].id
  cosmos: zones[6].id
  webPubSub: zones[7].id
  blob: zones[8].id
}
