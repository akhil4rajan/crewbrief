// Shared user-defined types and role ids for the CrewBrief modules.

@export()
@description('A data-plane or control-plane role grant for one principal on the resource a module creates.')
type roleAssignment = {
  @description('Object id of the managed identity, user or group.')
  principalId: string
  @description('Built-in role definition GUID (see roles below).')
  roleDefinitionId: string
  principalType: ('ServicePrincipal' | 'User' | 'Group')?
}

@export()
@description('Built-in Azure role definition ids used by CrewBrief (least privilege per service).')
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  keyVaultCryptoServiceEncryptionUser: 'e147488a-f6f5-4113-8e2d-b22465e65bf6'
  cognitiveServicesUser: 'a97b65f3-24c7-4388-baec-2e87135dc908'
  cognitiveServicesSpeechUser: 'f2dc8367-1007-4938-bd23-fe263f013447'
  cognitiveServicesOpenAIUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  searchIndexDataReader: '1407120a-92aa-4202-b7e9-c0e197c71c8f'
  searchIndexDataContributor: '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  searchServiceContributor: '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
  webPubSubServiceOwner: '12cf5a90-567b-43ae-8102-96cf46c7d9b4'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
}

@export()
@description('Cosmos DB built-in data-plane role: Cosmos DB Built-in Data Contributor.')
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'
