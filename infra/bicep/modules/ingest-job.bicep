// Manually triggered Container Apps job that loads the hazard library into AI Search from
// inside the VNet (Search has no public endpoint). Uses the backend image with a command override.

param location string
param tags object = {}
param name string
param environmentId string
param identityId string
param registryServer string
param image string = ''
param env array = []

var usePlaceholder = empty(image)

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [
        { server: registryServer, identity: identityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'ingest'
          image: usePlaceholder ? 'mcr.microsoft.com/k8se/quickstart-jobs:latest' : image
          command: usePlaceholder ? [] : ['python', '-m', 'knowledge.ingest', '--target', 'azure']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: env
        }
      ]
    }
  }
}

output name string = job.name
