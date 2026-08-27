import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPath = path.join(
  root,
  'deployment/aliyun/otto-compute-nest-contract.json',
);
const definitionsPath = path.join(
  root,
  'deployment/aliyun/plan-definitions.json',
);
const contractPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : defaultPath;
const forbiddenField =
  /(password|secret(value)?$|accesskey(secret)?$|license|privatekey|connection(string)?)/i;
const fail = (message) => {
  throw new Error(`[aliyun-contract] ${message}`);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};
const isObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const readJson = async (filePath) =>
  JSON.parse(await readFile(filePath, 'utf8'));
const normalizeOutputName = (name) =>
  `${name[0].toLowerCase()}${name.slice(1)}`;

function resourcesOfType(template, type) {
  return Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === type,
  );
}

function isRef(value, parameter) {
  return (
    isObject(value) &&
    value.Ref === parameter &&
    Object.keys(value).length === 1
  );
}

function isGetAtt(value, resource, attribute) {
  return (
    isObject(value) &&
    Array.isArray(value['Fn::GetAtt']) &&
    value['Fn::GetAtt'][0] === resource &&
    value['Fn::GetAtt'][1] === attribute
  );
}

function validateTemplate(contract, planName, template, plan, definition) {
  const prefix = `template ${planName}`;
  assert(
    template.ROSTemplateFormatVersion === '2015-09-01',
    `${prefix} has an invalid ROS format version`,
  );
  assert(isObject(template.Parameters), `${prefix} parameters are missing`);
  assert(isObject(template.Resources), `${prefix} resources are missing`);
  assert(isObject(template.Outputs), `${prefix} outputs are missing`);
  assert(
    template.Metadata?.Otto?.Plan === planName,
    `${prefix} metadata plan mismatch`,
  );
  assert(
    template.Metadata?.Otto?.Stage === contract.templates.stage,
    `${prefix} stage mismatch`,
  );
  assert(
    template.Metadata?.Otto?.RealDeploymentEnabled === false,
    `${prefix} must remain a local preview`,
  );
  assert(
    template.Parameters.TemplateVersion?.Default === contract.templateVersion,
    `${prefix} version drift`,
  );

  for (const parameter of [
    'DeploymentId',
    'OrderId',
    'IdempotencyKey',
    'TemplateVersion',
    'ZoneId',
    'SecondaryZoneId',
    'OttoImageId',
    'DatabaseCredentialRef',
    'CacheCredentialRef',
    'DomainMode',
    'DomainName',
    'DnsZoneName',
    'DnsRecordRr',
    'TlsCertificateId',
  ]) {
    assert(
      template.Parameters[parameter],
      `${prefix} is missing parameter ${parameter}`,
    );
  }
  assert(
    template.Parameters.ZoneId.AssociationPropertyMetadata?.ExclusiveTo?.includes(
      'SecondaryZoneId',
    ) &&
      template.Parameters.SecondaryZoneId.AssociationPropertyMetadata?.ExclusiveTo?.includes(
        'ZoneId',
      ),
    `${prefix} ALB zones must be distinct`,
  );
  assert(
    !Object.hasOwn(template.Parameters.DomainName, 'Default') &&
      template.Parameters.DomainName.MinLength >= 1 &&
      template.Parameters.DomainName.MaxLength <= 80,
    `${prefix} requires an explicit public domain`,
  );
  assert(
    !Object.hasOwn(template.Parameters.TlsCertificateId, 'Default') &&
      template.Parameters.TlsCertificateId.MinLength >= 1,
    `${prefix} requires an explicit CAS certificate ID`,
  );
  for (const parameter of ['DatabaseCredentialRef', 'CacheCredentialRef']) {
    const value = template.Parameters[parameter];
    assert(
      value.Type === 'ALIYUN::OOS::SecretParameter::Value',
      `${prefix}.${parameter} must use an OOS encrypted reference`,
    );
    assert(value.NoEcho === true, `${prefix}.${parameter} must be NoEcho`);
    assert(
      !Object.hasOwn(value, 'Default'),
      `${prefix}.${parameter} must not have a default`,
    );
  }
  const hidden = template.Metadata?.['ALIYUN::ROS::Interface']?.Hidden;
  assert(Array.isArray(hidden), `${prefix} hidden parameter list is missing`);
  for (const parameter of contract.parameters.systemManaged) {
    const rosName = `${parameter[0].toUpperCase()}${parameter.slice(1)}`;
    assert(
      hidden.includes(rosName),
      `${prefix} must hide system parameter ${rosName}`,
    );
  }

  const resourceTypes = new Set(
    Object.values(template.Resources).map((resource) => resource.Type),
  );
  for (const type of contract.templates.requiredResourceTypes) {
    assert(
      resourceTypes.has(type),
      `${prefix} is missing required resource ${type}`,
    );
  }

  const switches = resourcesOfType(template, 'ALIYUN::ECS::VSwitch');
  assert(
    switches.length ===
      plan.availabilityZones + definition.ingressAvailabilityZones,
    `${prefix} vSwitch count does not match application and ingress zones`,
  );
  const servers = resourcesOfType(template, 'ALIYUN::ECS::InstanceGroup');
  const serverCount = servers.reduce(
    (total, [, resource]) => total + resource.Properties.MaxAmount,
    0,
  );
  assert(
    serverCount === plan.statelessServers,
    `${prefix} stateless server count mismatch`,
  );
  for (const [name, server] of servers) {
    assert(
      server.Properties.InstanceType === definition.instanceType,
      `${prefix}.${name} instance type drift`,
    );
    assert(
      server.Properties.SystemDiskSize === definition.systemDiskSize,
      `${prefix}.${name} disk size drift`,
    );
    assert(
      server.Properties.AllocatePublicIP === false,
      `${prefix}.${name} must not allocate a public IP`,
    );
    assert(
      server.Properties.InternetMaxBandwidthOut === 0,
      `${prefix}.${name} public bandwidth must be zero`,
    );
    assert(
      !Object.hasOwn(server.Properties, 'Password'),
      `${prefix}.${name} must not contain a login password`,
    );
    assert(
      !Object.hasOwn(server.Properties, 'KeyPairName'),
      `${prefix}.${name} must not expose SSH credentials`,
    );
    assert(
      !Object.hasOwn(server.Properties, 'UserData'),
      `${prefix}.${name} bootstrap belongs to signed CLOUD-02 artifacts`,
    );
    assert(
      server.Properties.SystemDiskEncrypted === 'true',
      `${prefix}.${name} system disk must be encrypted`,
    );
    assert(
      server.Properties.RamRoleName,
      `${prefix}.${name} must use an instance RAM role`,
    );
  }

  const [[, database]] = resourcesOfType(template, 'ALIYUN::RDS::DBInstance');
  assert(
    database.Properties.DBInstanceClass === definition.database.class,
    `${prefix} database class drift`,
  );
  assert(
    database.Properties.DBInstanceStorage === definition.database.storage,
    `${prefix} database storage drift`,
  );
  assert(
    database.Properties.BackupRetentionPeriod ===
      definition.database.backupRetentionDays,
    `${prefix} database retention drift`,
  );
  assert(
    database.Properties.InstanceNetworkType === 'VPC',
    `${prefix} database must use VPC networking`,
  );
  assert(
    database.Properties.DBInstanceNetType === 'Intranet',
    `${prefix} database must use an intranet endpoint`,
  );
  assert(
    database.Properties.AllocatePublicConnection === false,
    `${prefix} database must not allocate a public endpoint`,
  );
  assert(
    isRef(database.Properties.MasterUserPassword, 'DatabaseCredentialRef'),
    `${prefix} database credential must come from the encrypted reference`,
  );
  assert(
    database.DeletionPolicy === 'Retain',
    `${prefix} database must survive stack deletion by default`,
  );

  const [[, cache]] = resourcesOfType(template, 'ALIYUN::REDIS::Instance');
  assert(
    cache.Properties.InstanceClass === definition.cache.class,
    `${prefix} cache class drift`,
  );
  assert(
    cache.Properties.VpcPasswordFree === false,
    `${prefix} cache must not enable password-free VPC access`,
  );
  assert(
    cache.Properties.SSLEnabled === 'Enable' &&
      cache.Properties.TLSProtocol === 'TLSv1.2',
    `${prefix} cache must require TLS 1.2`,
  );
  assert(
    isRef(cache.Properties.Password, 'CacheCredentialRef'),
    `${prefix} cache credential must come from the encrypted reference`,
  );
  assert(
    cache.DeletionPolicy === 'Retain',
    `${prefix} cache must survive stack deletion by default`,
  );

  const [[, bucket]] = resourcesOfType(template, 'ALIYUN::OSS::Bucket');
  assert(
    bucket.Properties.RedundancyType === definition.objectStorage.redundancy,
    `${prefix} OSS redundancy drift`,
  );
  assert(
    bucket.Properties.AccessControl === 'private' &&
      bucket.Properties.BlockPublicAccess === true,
    `${prefix} OSS must block public access`,
  );
  assert(
    bucket.Properties.VersioningConfiguration?.Status === 'Enabled',
    `${prefix} OSS versioning must be enabled`,
  );
  assert(
    bucket.Properties.ServerSideEncryptionConfiguration?.SSEAlgorithm === 'KMS',
    `${prefix} OSS must use KMS encryption`,
  );

  const [[, key]] = resourcesOfType(template, 'ALIYUN::KMS::Key');
  assert(
    key.Properties.KeySpec === 'Aliyun_AES_256',
    `${prefix} KMS key must use AES-256`,
  );
  assert(
    key.Properties.EnableAutomaticRotation === true &&
      key.Properties.DeletionProtection === true,
    `${prefix} KMS key must enable rotation and deletion protection`,
  );

  const loadBalancers = resourcesOfType(template, 'ALIYUN::ALB::LoadBalancer');
  assert(loadBalancers.length === 1, `${prefix} must contain exactly one ALB`);
  const [[loadBalancerName, loadBalancer]] = loadBalancers;
  assert(
    loadBalancer.Properties.AddressType === 'Internet',
    `${prefix} ALB must be internet-facing`,
  );
  assert(
    loadBalancer.Properties.AddressIpVersion === 'IPv4',
    `${prefix} ALB must use IPv4`,
  );
  assert(
    loadBalancer.Properties.LoadBalancerEdition ===
      definition.loadBalancerEdition,
    `${prefix} ALB edition drift`,
  );
  assert(
    Array.isArray(loadBalancer.Properties.ZoneMappings) &&
      loadBalancer.Properties.ZoneMappings.length === 2,
    `${prefix} ALB must use two zones`,
  );
  const zoneRefs = loadBalancer.Properties.ZoneMappings.map(
    (mapping) => mapping.ZoneId?.Ref,
  );
  const switchRefs = loadBalancer.Properties.ZoneMappings.map(
    (mapping) => mapping.VSwitchId?.Ref,
  );
  assert(
    JSON.stringify(zoneRefs) === '["ZoneId","SecondaryZoneId"]' &&
      JSON.stringify(switchRefs) ===
        '["IngressVSwitchPrimary","IngressVSwitchSecondary"]',
    `${prefix} ALB zone mappings must use distinct managed vSwitches`,
  );

  const serverGroups = resourcesOfType(template, 'ALIYUN::ALB::ServerGroup');
  assert(
    serverGroups.length === 1,
    `${prefix} must contain exactly one ALB server group`,
  );
  const [[serverGroupName, serverGroup]] = serverGroups;
  const health = serverGroup.Properties.HealthCheckConfig;
  assert(
    serverGroup.Properties.Protocol === contract.publicEntry.backend.protocol &&
      health?.HealthCheckEnabled === true &&
      health.HealthCheckConnectPort === contract.publicEntry.backend.port &&
      health.HealthCheckProtocol === contract.publicEntry.backend.protocol &&
      health.HealthCheckPath === contract.publicEntry.backend.healthPath &&
      isRef(health.HealthCheckHost, 'DomainName') &&
      JSON.stringify(health.HealthCheckCodes) === '["http_2xx"]',
    `${prefix} ALB health check contract drift`,
  );
  if (definition.loadBalancerEdition === 'Basic') {
    assert(
      !Object.hasOwn(serverGroup.Properties, 'ConnectionDrainConfig'),
      `${prefix} Basic ALB must not use unsupported connection draining`,
    );
  } else {
    assert(
      serverGroup.Properties.ConnectionDrainConfig?.ConnectionDrainEnabled ===
        true &&
        serverGroup.Properties.ConnectionDrainConfig.ConnectionDrainTimeout ===
          60,
      `${prefix} Standard ALB must enable connection draining`,
    );
  }

  const attachments = resourcesOfType(
    template,
    'ALIYUN::ALB::BackendServerAttachment',
  );
  assert(
    attachments.length === 1,
    `${prefix} must contain exactly one ALB backend attachment`,
  );
  const [[, attachment]] = attachments;
  assert(
    isGetAtt(
      attachment.Properties.ServerGroupId,
      serverGroupName,
      'ServerGroupId',
    ),
    `${prefix} ALB backend attachment must target the managed server group`,
  );
  assert(
    Array.isArray(attachment.Properties.Servers) &&
      attachment.Properties.Servers.length === plan.statelessServers &&
      attachment.Properties.Servers.every(
        (server) =>
          server.ServerType === 'Ecs' &&
          server.Port === contract.publicEntry.backend.port,
      ),
    `${prefix} ALB backend attachment must contain only private Otto servers`,
  );

  const listeners = resourcesOfType(template, 'ALIYUN::ALB::Listener');
  assert(
    listeners.length === 1,
    `${prefix} must expose exactly one ALB listener`,
  );
  const [[listenerName, listener]] = listeners;
  assert(
    isGetAtt(
      listener.Properties.LoadBalancerId,
      loadBalancerName,
      'LoadBalancerId',
    ),
    `${prefix} HTTPS listener must target the managed ALB`,
  );
  assert(
    listener.Properties.ListenerProtocol === 'HTTPS' &&
      listener.Properties.ListenerPort === 443,
    `${prefix} public listener must be HTTPS on port 443`,
  );
  assert(
    listener.Properties.SecurityPolicyId ===
      contract.publicEntry.tlsSecurityPolicy,
    `${prefix} TLS security policy is not TLS 1.2+ strict`,
  );
  assert(
    listener.Properties.XForwardedForConfig?.XForwardedForEnabled === true &&
      listener.Properties.XForwardedForConfig.XForwardedForProcessingMode ===
        'append' &&
      listener.Properties.XForwardedForConfig.XForwardedForProtoEnabled ===
        true &&
      listener.Properties.XForwardedForConfig.XForwardedForHostEnabled ===
        false,
    `${prefix} ALB proxy-header policy must append client IP and reject forwarded host trust`,
  );
  assert(
    Array.isArray(listener.Properties.Certificates) &&
      listener.Properties.Certificates.length === 1 &&
      isRef(
        listener.Properties.Certificates[0].CertificateId,
        'TlsCertificateId',
      ),
    `${prefix} HTTPS listener must use the external CAS certificate ID`,
  );
  assert(
    listener.Properties.DefaultActions?.[0]?.Type === 'ForwardGroup' &&
      isGetAtt(
        listener.Properties.DefaultActions[0].ForwardGroupConfig
          ?.ServerGroupTuples?.[0]?.ServerGroupId,
        serverGroupName,
        'ServerGroupId',
      ),
    `${prefix} HTTPS listener must forward only to the managed server group`,
  );

  const dnsRecords = resourcesOfType(template, 'ALIYUN::DNS::DomainRecord');
  assert(
    dnsRecords.length === 1,
    `${prefix} must contain exactly one public DNS record`,
  );
  const [[, dnsRecord]] = dnsRecords;
  assert(
    dnsRecord.DependsOn === listenerName &&
      isRef(dnsRecord.Properties.DomainName, 'DnsZoneName') &&
      isRef(dnsRecord.Properties.RR, 'DnsRecordRr') &&
      dnsRecord.Properties.Type === 'CNAME' &&
      isGetAtt(dnsRecord.Properties.Value, loadBalancerName, 'DNSName'),
    `${prefix} DNS record must map the validated domain to the managed ALB`,
  );
  assert(
    isGetAtt(
      template.Outputs.LoadBalancerDnsName?.Value,
      loadBalancerName,
      'DNSName',
    ) &&
      JSON.stringify(template.Outputs.PublicHttpsOrigin?.Value) ===
        '{"Fn::Join":["",["https://",{"Ref":"DomainName"}]]}',
    `${prefix} public HTTPS outputs are missing or unsafe`,
  );

  const backendIngress = resourcesOfType(
    template,
    'ALIYUN::ECS::SecurityGroupIngress',
  ).filter(([, ingress]) => ingress.Properties.PortRange === '7777/7777');
  assert(
    backendIngress.length === 2 &&
      JSON.stringify(
        backendIngress
          .map(([, ingress]) => ingress.Properties.SourceCidrIp)
          .sort(),
      ) === '["10.42.10.0/24","10.42.11.0/24"]',
    `${prefix} Otto backend port must accept only the two ALB subnets`,
  );

  for (const [name, ingress] of resourcesOfType(
    template,
    'ALIYUN::ECS::SecurityGroupIngress',
  )) {
    const publicSource = ['0.0.0.0/0', '::/0'].includes(
      ingress.Properties.SourceCidrIp,
    );
    if (publicSource) {
      assert(
        ['80/80', '443/443'].includes(ingress.Properties.PortRange),
        `${prefix}.${name} exposes a forbidden public port`,
      );
    }
    assert(
      ingress.Properties.PortRange !== '22/22' &&
        ingress.Properties.PortRange !== '3389/3389',
      `${prefix}.${name} must not expose an administration port`,
    );
  }

  for (const output of Object.keys(template.Outputs)) {
    const normalized = normalizeOutputName(output);
    assert(
      contract.outputs.allowed.includes(normalized),
      `${prefix} contains undeclared output ${output}`,
    );
    assert(
      !forbiddenField.test(output),
      `${prefix} output is secret-like: ${output}`,
    );
  }
}

const contract = await readJson(contractPath);
const definitions = await readJson(definitionsPath);
assert(
  contract.format === 'otto-aliyun-compute-nest-contract-v1',
  'unsupported contract format',
);
assert(
  definitions.format === 'otto-aliyun-plan-definitions-v1',
  'unsupported plan definition format',
);
assert(
  definitions.templateVersion === contract.templateVersion,
  'plan definition and contract versions must match',
);
assert(
  contract.realDeploymentEnabled === false,
  'local contract must not enable real cloud deployment',
);
assert(
  Array.isArray(contract.supportedRegions) &&
    contract.supportedRegions.length > 0,
  'supported regions are required',
);
assert(isObject(contract.plans), 'plans are required');
assert(isObject(contract.templates?.files), 'template file map is required');
for (const planName of ['trial', 'standard', 'ha']) {
  const plan = contract.plans[planName];
  const definition = definitions.plans[planName];
  assert(isObject(plan), `${planName} plan is required`);
  assert(isObject(definition), `${planName} plan definition is required`);
  assert(
    plan.availabilityZones >= 1 && plan.statelessServers >= 1,
    `${planName} capacity is invalid`,
  );
  assert(
    plan.availabilityZones === definition.availabilityZones,
    `${planName} availability-zone definition drift`,
  );
  assert(
    definition.ingressAvailabilityZones === 2,
    `${planName} public ALB must use two ingress zones`,
  );
  assert(
    plan.statelessServers === definition.statelessServers,
    `${planName} server definition drift`,
  );
  assert(
    path.basename(contract.templates.files[planName]) ===
      definition.templateFile,
    `${planName} template filename drift`,
  );
  for (const service of ['postgres', 'tair', 'oss']) {
    assert(isObject(plan[service]), `${planName}.${service} is required`);
    assert(
      plan[service].public === false,
      `${planName}.${service} must be private`,
    );
  }
  assert(
    plan.oss.versioning === true && plan.oss.sseKms === true,
    `${planName}.oss must use versioning and KMS encryption`,
  );
  const templatePath = path.resolve(root, contract.templates.files[planName]);
  validateTemplate(
    contract,
    planName,
    await readJson(templatePath),
    plan,
    definition,
  );
}
assert(
  contract.network.tls.httpsRequired === true &&
    contract.network.tls.minimumVersion === '1.2',
  'TLS must be HTTPS with TLS 1.2 minimum',
);
assert(
  JSON.stringify(contract.network.publicPorts) === '[443]',
  'only 443 may be public',
);
assert(
  contract.publicEntry?.provider === 'aliyun-alb',
  'public entry must use Alibaba Cloud ALB',
);
assert(
  contract.publicEntry.internetFacing === true &&
    contract.publicEntry.availabilityZones === 2,
  'public ALB must be internet-facing and dual-zone',
);
assert(
  JSON.stringify(contract.publicEntry.listenerPorts) === '[443]',
  'public ALB may listen only on 443',
);
assert(
  contract.publicEntry.backend?.port === 7777 &&
    contract.publicEntry.backend?.healthPath === '/enterprise/health',
  'private ALB backend contract drift',
);
assert(
  contract.publicEntry.certificatePrivateKeyTemplateInputAllowed === false,
  'certificate private keys must not be ROS inputs',
);
assert(
  contract.network.ssh.defaultEnabled === false,
  'SSH must default to disabled',
);
assert(
  contract.secrets.plaintextAllowed === false &&
    contract.secrets.missingDependencyAction === 'fail-closed',
  'secrets must fail closed',
);
assert(
  contract.idempotency.replayMustNotCreateResources === true,
  'replays must not create resources',
);
assert(
  Array.isArray(contract.idempotency.requiredFields) &&
    contract.idempotency.requiredFields.includes('idempotencyKey'),
  'idempotency key is required',
);
assert(
  contract.evidence.realCloudRunRequiredForCompletion === true,
  'real cloud evidence requirement must remain explicit',
);
for (const listPath of [
  contract.parameters.allowed,
  contract.parameters.systemManaged,
  contract.parameters.forbidden,
  contract.outputs.allowed,
  contract.outputs.forbidden,
]) {
  assert(Array.isArray(listPath), 'contract field lists must be arrays');
}
for (const entry of [
  ...contract.parameters.allowed,
  ...contract.outputs.allowed,
]) {
  assert(
    !forbiddenField.test(entry),
    `plaintext or secret-like field is allowed: ${entry}`,
  );
}
for (const [from, destinations] of Object.entries(
  contract.states.transitions,
)) {
  assert(
    Array.isArray(destinations) && destinations.length > 0,
    `state ${from} has no transitions`,
  );
  for (const destination of destinations)
    assert(
      destination in contract.states.transitions,
      `unknown state ${destination}`,
    );
}
assert(
  contract.states.initial in contract.states.transitions,
  'initial state is unknown',
);
for (const terminal of contract.states.terminal)
  assert(
    contract.states.transitions[terminal],
    `terminal state ${terminal} is unknown`,
  );
console.log(
  `[aliyun-contract] valid: ${contract.templateVersion}; templates=3; realDeploymentEnabled=${contract.realDeploymentEnabled}`,
);
