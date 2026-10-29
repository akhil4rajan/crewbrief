// Private endpoint for one sub-resource (groupId), registered in the given private DNS zones.

param name string
param location string
param tags object = {}
param subnetId string
param targetResourceId string
@description('Private link sub-resource, e.g. vault, registry, account, searchService, Sql, webpubsub, blob.')
param groupId string
param privateDnsZoneIds array

resource pe 'Microsoft.Network/privateEndpoints@2024-01-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      {
        name: name
        properties: {
          privateLinkServiceId: targetResourceId
          groupIds: [groupId]
        }
      }
    ]
  }
}

resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [for (zoneId, i) in privateDnsZoneIds: {
      name: 'zone-${i}'
      properties: { privateDnsZoneId: zoneId }
    }]
  }
}

output id string = pe.id
