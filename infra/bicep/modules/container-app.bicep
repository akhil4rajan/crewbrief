// One CrewBrief container app: managed identity, image from ACR, Key Vault secret refs,
// health probes and a KEDA HTTP scale rule.

param location string
param tags object = {}
param name string
@description('azd service name; azd finds the app by this tag when deploying.')
param azdServiceName string
param environmentId string
param identityId string
param registryServer string
@description('Image to run. Empty on the first provision, before azd has pushed one: a public placeholder runs instead.')
param image string = ''
param targetPort int
param external bool
param env array = []
@description('[{ name, keyVaultUrl }] secrets resolved from Key Vault with the app identity.')
param keyVaultSecrets array = []
param cpu string = '0.5'
param memory string = '1Gi'
param minReplicas int = 1
param maxReplicas int = 10
@description('Concurrent requests per replica before KEDA adds one. Long-lived WebSockets count as requests.')
param concurrentRequests int = 50
param scaleRuleName string = 'http-concurrency'
param livenessPath string = '/healthz'
param readinessPath string = '/readyz'

var usePlaceholder = empty(image)
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'
var port = usePlaceholder ? 80 : targetPort

var probes = usePlaceholder ? [] : [
  {
    type: 'Startup'
    httpGet: { path: livenessPath, port: port }
    initialDelaySeconds: 3
    periodSeconds: 3
    failureThreshold: 20
  }
  {
    type: 'Liveness'
    httpGet: { path: livenessPath, port: port }
    periodSeconds: 10
    timeoutSeconds: 3
    failureThreshold: 3
  }
  {
    type: 'Readiness'
    httpGet: { path: readinessPath, port: port }
    periodSeconds: 5
    timeoutSeconds: 3
    failureThreshold: 3
  }
]

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: union(tags, { 'azd-service-name': azdServiceName })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: external
        targetPort: port
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        { server: registryServer, identity: identityId }
      ]
      secrets: [for s in keyVaultSecrets: {
        name: s.name
        keyVaultUrl: s.keyVaultUrl
        identity: identityId
      }]
    }
    template: {
      containers: [
        {
          name: azdServiceName
          image: usePlaceholder ? placeholderImage : image
          resources: { cpu: json(cpu), memory: memory }
          env: env
          probes: probes
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: scaleRuleName
            http: { metadata: { concurrentRequests: string(concurrentRequests) } }
          }
        ]
      }
    }
  }
}

output name string = app.name
output fqdn string = app.properties.configuration.ingress.fqdn
