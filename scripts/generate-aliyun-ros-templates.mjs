import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitionsPath = path.join(
  root,
  'deployment/aliyun/plan-definitions.json',
);
const outputDirectory = path.join(root, 'deployment/aliyun/templates/ros');
const checkOnly = process.argv.includes('--check');

const definitions = JSON.parse(await readFile(definitionsPath, 'utf8'));

function ref(name) {
  return { Ref: name };
}

function getAtt(resource, attribute) {
  return { 'Fn::GetAtt': [resource, attribute] };
}

function select(index, value) {
  return { 'Fn::Select': [index, value] };
}

function joinedName(suffix) {
  return { 'Fn::Join': ['-', ['otto', ref('DeploymentId'), suffix]] };
}

function systemParameters() {
  const parameters = {
    DeploymentId: {
      Type: 'String',
      AllowedPattern: '^[a-z0-9][a-z0-9-]{7,31}$',
      Description:
        'Unpredictable deployment identifier issued by Otto Control.',
    },
    OrderId: { Type: 'String', MinLength: 8, MaxLength: 128 },
    IdempotencyKey: {
      Type: 'String',
      MinLength: 16,
      MaxLength: 128,
      NoEcho: true,
    },
    TemplateVersion: { Type: 'String', Default: definitions.templateVersion },
    ZoneId: {
      Type: 'String',
      AssociationProperty: 'ALIYUN::ECS::Instance:ZoneId',
      AssociationPropertyMetadata: { ExclusiveTo: ['SecondaryZoneId'] },
    },
    SecondaryZoneId: {
      Type: 'String',
      AssociationProperty: 'ALIYUN::ECS::Instance:ZoneId',
      AssociationPropertyMetadata: { ExclusiveTo: ['ZoneId'] },
      Description: 'A distinct second zone required by the public ALB.',
    },
    EnterpriseDisplayName: { Type: 'String', MinLength: 1, MaxLength: 64 },
    DomainMode: {
      Type: 'String',
      AllowedValues: ['managed', 'existing'],
      Default: 'managed',
    },
    DomainName: {
      Type: 'String',
      MinLength: 4,
      MaxLength: 80,
      AllowedPattern:
        '^(?=.{4,80}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$',
      Description:
        'Validated FQDN whose certificate and DNS record are supplied by the deployment control plane.',
    },
    DnsZoneName: {
      Type: 'String',
      MinLength: 3,
      MaxLength: 253,
      AllowedPattern:
        '^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$',
      Description:
        'Alibaba Cloud DNS zone that already belongs to the deploying account.',
    },
    DnsRecordRr: {
      Type: 'String',
      MinLength: 1,
      MaxLength: 128,
      AllowedPattern: '^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$',
      Description:
        'Non-apex DNS record name derived and validated by the deployment control plane.',
    },
    TlsCertificateId: {
      Type: 'String',
      MinLength: 1,
      MaxLength: 128,
      Description:
        'Existing CAS server certificate ID matching DomainName. Certificate private keys are never template inputs.',
    },
    OttoImageId: {
      Type: 'String',
      AssociationProperty: 'ALIYUN::ECS::Image::ImageId',
      Description:
        'Pinned Compute Nest image artifact. Never accept latest or an arbitrary URL.',
    },
    DatabaseCredentialRef: {
      Type: 'ALIYUN::OOS::SecretParameter::Value',
      NoEcho: true,
      Description:
        'OOS encrypted parameter reference supplied by the deployment control plane.',
    },
    CacheCredentialRef: {
      Type: 'ALIYUN::OOS::SecretParameter::Value',
      NoEcho: true,
      Description:
        'OOS encrypted parameter reference supplied by the deployment control plane.',
    },
  };
  return parameters;
}

function serverRole(bucketName) {
  return {
    Type: 'ALIYUN::RAM::Role',
    Properties: {
      RoleName: joinedName('server-role'),
      MaxSessionDuration: 3600,
      DeletionForce: true,
      AssumeRolePolicyDocument: {
        Version: '1',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: ['ecs.aliyuncs.com'] },
          },
        ],
      },
      Policies: [
        {
          PolicyName: 'otto-object-storage',
          PolicyDocument: {
            Version: '1',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'oss:GetObject',
                  'oss:PutObject',
                  'oss:DeleteObject',
                  'oss:ListObjects',
                ],
                Resource: [
                  { 'Fn::Join': ['', ['acs:oss:*:*:', bucketName]] },
                  { 'Fn::Join': ['', ['acs:oss:*:*:', bucketName, '/*']] },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}

function serverResource(plan, logicalId, zoneId, vSwitchId) {
  return {
    Type: 'ALIYUN::ECS::InstanceGroup',
    DependsOn: ['ServerRole', 'SecurityGroup'],
    Properties: {
      MaxAmount: 1,
      InstanceType: plan.instanceType,
      ImageId: ref('OttoImageId'),
      VpcId: ref('Vpc'),
      VSwitchId: ref(vSwitchId),
      ZoneId: ref(zoneId),
      SecurityGroupId: ref('SecurityGroup'),
      RamRoleName: getAtt('ServerRole', 'RoleName'),
      InstanceChargeType: 'PostPaid',
      NetworkType: 'vpc',
      AllocatePublicIP: false,
      InternetMaxBandwidthOut: 0,
      SystemDiskCategory: 'cloud_essd',
      SystemDiskSize: plan.systemDiskSize,
      SystemDiskEncrypted: 'true',
      SystemDiskKMSKeyId: getAtt('DataEncryptionKey', 'KeyId'),
      DeletionProtection: true,
      SecurityEnhancementStrategy: 'Active',
      InstanceName: joinedName(
        logicalId === 'OttoServerPrimary' ? 'server-a' : 'server-b',
      ),
      Tags: [
        { Key: 'otto:deployment-id', Value: ref('DeploymentId') },
        { Key: 'otto:template-version', Value: ref('TemplateVersion') },
      ],
    },
  };
}

function buildTemplate(planName, plan) {
  const bucketName = joinedName('data');
  const resources = {
    Vpc: {
      Type: 'ALIYUN::ECS::VPC',
      Properties: { VpcName: joinedName('vpc'), CidrBlock: '10.42.0.0/16' },
    },
    VSwitchPrimary: {
      Type: 'ALIYUN::ECS::VSwitch',
      Properties: {
        VpcId: ref('Vpc'),
        ZoneId: ref('ZoneId'),
        CidrBlock: '10.42.1.0/24',
        VSwitchName: joinedName('vsw-a'),
      },
    },
    IngressVSwitchPrimary: {
      Type: 'ALIYUN::ECS::VSwitch',
      Properties: {
        VpcId: ref('Vpc'),
        ZoneId: ref('ZoneId'),
        CidrBlock: '10.42.10.0/24',
        VSwitchName: joinedName('ingress-vsw-a'),
      },
    },
    IngressVSwitchSecondary: {
      Type: 'ALIYUN::ECS::VSwitch',
      Properties: {
        VpcId: ref('Vpc'),
        ZoneId: ref('SecondaryZoneId'),
        CidrBlock: '10.42.11.0/24',
        VSwitchName: joinedName('ingress-vsw-b'),
      },
    },
    SecurityGroup: {
      Type: 'ALIYUN::ECS::SecurityGroup',
      Properties: {
        VpcId: ref('Vpc'),
        SecurityGroupName: joinedName('server-sg'),
        SecurityGroupType: 'enterprise',
        SecurityGroupEgress: [
          {
            IpProtocol: 'all',
            DestCidrIp: '0.0.0.0/0',
            PortRange: '-1/-1',
            Priority: 100,
          },
        ],
      },
    },
    AlbPrimaryServiceIngress: {
      Type: 'ALIYUN::ECS::SecurityGroupIngress',
      Properties: {
        SecurityGroupId: ref('SecurityGroup'),
        IpProtocol: 'tcp',
        PortRange: '7777/7777',
        SourceCidrIp: '10.42.10.0/24',
        Priority: 10,
      },
    },
    AlbSecondaryServiceIngress: {
      Type: 'ALIYUN::ECS::SecurityGroupIngress',
      Properties: {
        SecurityGroupId: ref('SecurityGroup'),
        IpProtocol: 'tcp',
        PortRange: '7777/7777',
        SourceCidrIp: '10.42.11.0/24',
        Priority: 10,
      },
    },
    DataEncryptionKey: {
      Type: 'ALIYUN::KMS::Key',
      Properties: {
        KeySpec: 'Aliyun_AES_256',
        KeyUsage: 'ENCRYPT/DECRYPT',
        Enable: true,
        EnableAutomaticRotation: true,
        RotationInterval: '90d',
        DeletionProtection: true,
        PendingWindowInDays: 30,
        Description: 'Otto private deployment data encryption key',
      },
    },
    ObjectStorage: {
      Type: 'ALIYUN::OSS::Bucket',
      DependsOn: 'DataEncryptionKey',
      Properties: {
        BucketName: bucketName,
        AccessControl: 'private',
        BlockPublicAccess: true,
        DeletionForce: false,
        StorageClass: 'Standard',
        RedundancyType: plan.objectStorage.redundancy,
        VersioningConfiguration: { Status: 'Enabled' },
        ServerSideEncryptionConfiguration: {
          SSEAlgorithm: 'KMS',
          KMSMasterKeyID: getAtt('DataEncryptionKey', 'KeyId'),
        },
        Tags: { 'otto:deployment-id': ref('DeploymentId') },
      },
    },
    ServerRole: serverRole(bucketName),
    Database: {
      Type: 'ALIYUN::RDS::DBInstance',
      DependsOn: ['VSwitchPrimary', 'SecurityGroup'],
      DeletionPolicy: 'Retain',
      Properties: {
        Engine: 'PostgreSQL',
        EngineVersion: '16.0',
        DBInstanceClass: plan.database.class,
        DBInstanceStorage: plan.database.storage,
        DBInstanceStorageType: 'cloud_essd',
        Category: plan.database.category,
        PayType: 'Postpaid',
        ZoneId: ref('ZoneId'),
        VpcId: ref('Vpc'),
        VSwitchId: ref('VSwitchPrimary'),
        InstanceNetworkType: 'VPC',
        DBInstanceNetType: 'Intranet',
        AllocatePublicConnection: false,
        SecurityIPList: '10.42.0.0/16',
        SecurityGroupId: ref('SecurityGroup'),
        MasterUsername: 'otto_admin',
        MasterUserPassword: ref('DatabaseCredentialRef'),
        MultiAZ: plan.database.multiAz,
        BackupRetentionPeriod: plan.database.backupRetentionDays,
        DeletionProtection: plan.database.deletionProtection,
      },
    },
    Cache: {
      Type: 'ALIYUN::REDIS::Instance',
      DependsOn: ['VSwitchPrimary', 'SecurityGroup'],
      DeletionPolicy: 'Retain',
      Properties: {
        VpcId: ref('Vpc'),
        VSwitchId: ref('VSwitchPrimary'),
        ZoneId: ref('ZoneId'),
        InstanceClass: plan.cache.class,
        EngineVersion: '7.0',
        InstanceName: joinedName('cache'),
        ChargeType: 'PostPaid',
        EvictionPolicy: 'noeviction',
        VpcPasswordFree: false,
        Password: ref('CacheCredentialRef'),
        SecurityGroupId: ref('SecurityGroup'),
        SSLEnabled: 'Enable',
        TLSProtocol: 'TLSv1.2',
        DeletionForce: false,
      },
    },
  };

  if (plan.availabilityZones > 1) {
    resources.VSwitchSecondary = {
      Type: 'ALIYUN::ECS::VSwitch',
      Properties: {
        VpcId: ref('Vpc'),
        ZoneId: ref('SecondaryZoneId'),
        CidrBlock: '10.42.2.0/24',
        VSwitchName: joinedName('vsw-b'),
      },
    };
    resources.Database.Properties.VSwitchId = {
      'Fn::Join': [',', [ref('VSwitchPrimary'), ref('VSwitchSecondary')]],
    };
    resources.Database.Properties.SlaveZoneIds = [ref('SecondaryZoneId')];
    resources.Cache.Properties.SecondaryZoneId = ref('SecondaryZoneId');
  }

  resources.OttoServerPrimary = serverResource(
    plan,
    'OttoServerPrimary',
    'ZoneId',
    'VSwitchPrimary',
  );
  if (plan.statelessServers > 1) {
    resources.OttoServerSecondary = serverResource(
      plan,
      'OttoServerSecondary',
      'SecondaryZoneId',
      'VSwitchSecondary',
    );
  }

  const backendServers = [
    {
      ServerType: 'Ecs',
      ServerId: select(0, getAtt('OttoServerPrimary', 'InstanceIds')),
      Port: 7777,
      Weight: 100,
    },
  ];
  if (plan.statelessServers > 1) {
    backendServers.push({
      ServerType: 'Ecs',
      ServerId: select(0, getAtt('OttoServerSecondary', 'InstanceIds')),
      Port: 7777,
      Weight: 100,
    });
  }

  resources.ApplicationLoadBalancer = {
    Type: 'ALIYUN::ALB::LoadBalancer',
    DependsOn: ['IngressVSwitchPrimary', 'IngressVSwitchSecondary'],
    Properties: {
      LoadBalancerName: joinedName('alb'),
      LoadBalancerEdition: plan.loadBalancerEdition,
      VpcId: ref('Vpc'),
      LoadBalancerBillingConfig: { PayType: 'PostPay' },
      AddressType: 'Internet',
      AddressIpVersion: 'IPv4',
      AddressAllocatedMode: 'Dynamic',
      ZoneMappings: [
        {
          ZoneId: ref('ZoneId'),
          VSwitchId: ref('IngressVSwitchPrimary'),
        },
        {
          ZoneId: ref('SecondaryZoneId'),
          VSwitchId: ref('IngressVSwitchSecondary'),
        },
      ],
      DeletionProtectionEnabled: false,
      Tags: [{ Key: 'otto:deployment-id', Value: ref('DeploymentId') }],
    },
  };
  resources.ApplicationServerGroup = {
    Type: 'ALIYUN::ALB::ServerGroup',
    Properties: {
      VpcId: ref('Vpc'),
      ServerGroupName: joinedName('server-group'),
      ServerGroupType: 'Instance',
      Protocol: 'HTTP',
      Scheduler: 'Wlc',
      CrossZoneEnabled: true,
      UpstreamKeepaliveEnabled: true,
      StickySessionConfig: { StickySessionEnabled: false },
      ...(plan.loadBalancerEdition === 'Basic'
        ? {}
        : {
            ConnectionDrainConfig: {
              ConnectionDrainEnabled: true,
              ConnectionDrainTimeout: 60,
            },
          }),
      HealthCheckConfig: {
        HealthCheckEnabled: true,
        HealthCheckConnectPort: 7777,
        HealthCheckProtocol: 'HTTP',
        HealthCheckMethod: 'GET',
        HealthCheckPath: '/enterprise/health',
        HealthCheckHost: ref('DomainName'),
        HealthCheckCodes: ['http_2xx'],
        HealthCheckInterval: 5,
        HealthCheckTimeout: 3,
        HealthyThreshold: 3,
        UnhealthyThreshold: 3,
      },
      Tags: [{ Key: 'otto:deployment-id', Value: ref('DeploymentId') }],
    },
  };
  resources.ApplicationBackends = {
    Type: 'ALIYUN::ALB::BackendServerAttachment',
    DependsOn: Object.keys(resources).filter((name) =>
      name.startsWith('OttoServer'),
    ),
    Properties: {
      ServerGroupId: getAtt('ApplicationServerGroup', 'ServerGroupId'),
      Servers: backendServers,
    },
  };
  resources.HttpsListener = {
    Type: 'ALIYUN::ALB::Listener',
    DependsOn: 'ApplicationBackends',
    Properties: {
      LoadBalancerId: getAtt('ApplicationLoadBalancer', 'LoadBalancerId'),
      ListenerPort: 443,
      ListenerProtocol: 'HTTPS',
      ListenerDescription: 'Otto enterprise HTTPS only',
      SecurityPolicyId: 'tls_cipher_policy_1_2_strict_with_1_3',
      Certificates: [{ CertificateId: ref('TlsCertificateId') }],
      Http2Enabled: true,
      GzipEnabled: false,
      IdleTimeout: 60,
      RequestTimeout: 180,
      XForwardedForConfig: {
        XForwardedForEnabled: true,
        XForwardedForProcessingMode: 'append',
        XForwardedForProtoEnabled: true,
        XForwardedForHostEnabled: false,
      },
      DefaultActions: [
        {
          Type: 'ForwardGroup',
          ForwardGroupConfig: {
            ServerGroupTuples: [
              {
                ServerGroupId: getAtt(
                  'ApplicationServerGroup',
                  'ServerGroupId',
                ),
              },
            ],
          },
        },
      ],
    },
  };
  resources.PublicDnsRecord = {
    Type: 'ALIYUN::DNS::DomainRecord',
    DependsOn: 'HttpsListener',
    Properties: {
      DomainName: ref('DnsZoneName'),
      RR: ref('DnsRecordRr'),
      Type: 'CNAME',
      Value: getAtt('ApplicationLoadBalancer', 'DNSName'),
      TTL: 600,
    },
  };

  const instanceIds = [getAtt('OttoServerPrimary', 'InstanceIds')];
  if (plan.statelessServers > 1)
    instanceIds.push(getAtt('OttoServerSecondary', 'InstanceIds'));

  const hiddenParameters = [
    'DeploymentId',
    'OrderId',
    'IdempotencyKey',
    'TemplateVersion',
    'OttoImageId',
    'DatabaseCredentialRef',
    'CacheCredentialRef',
    'DnsZoneName',
    'DnsRecordRr',
    'TlsCertificateId',
  ];

  return {
    ROSTemplateFormatVersion: '2015-09-01',
    Description: {
      'zh-cn': `Otto ${planName} 套餐私有化部署基础设施本地预览模板`,
      en: `Otto ${planName} private deployment infrastructure local preview`,
    },
    Parameters: systemParameters(),
    Resources: resources,
    Outputs: {
      DeploymentId: { Value: ref('DeploymentId') },
      OrderId: { Value: ref('OrderId') },
      TemplateVersion: { Value: ref('TemplateVersion') },
      VpcId: { Value: ref('Vpc') },
      ServerInstanceIds: { Value: instanceIds },
      DatabaseInstanceId: { Value: getAtt('Database', 'DBInstanceId') },
      CacheInstanceId: { Value: getAtt('Cache', 'InstanceId') },
      OssBucketRef: { Value: getAtt('ObjectStorage', 'Name') },
      KmsKeyRef: { Value: getAtt('DataEncryptionKey', 'KeyId') },
      LoadBalancerDnsName: {
        Value: getAtt('ApplicationLoadBalancer', 'DNSName'),
      },
      PublicHttpsOrigin: {
        Value: { 'Fn::Join': ['', ['https://', ref('DomainName')]] },
      },
    },
    Metadata: {
      Otto: {
        Plan: planName,
        Stage: 'local-preview',
        RealDeploymentEnabled: false,
        RequiredFollowUp: [
          'CLOUD-02',
          'CLOUD-03',
          'CLOUD-04',
          'CLOUD-05',
          'QA-10',
        ],
      },
      'ALIYUN::ROS::Interface': {
        Hidden: hiddenParameters,
        ParameterGroups: [
          {
            Parameters: ['ZoneId', 'SecondaryZoneId'],
            Label: { default: 'Network' },
          },
          {
            Parameters: ['EnterpriseDisplayName', 'DomainMode', 'DomainName'],
            Label: { default: 'Otto' },
          },
        ],
      },
    },
  };
}

async function writeOrCheck(filePath, content) {
  if (checkOnly) {
    let existing = '';
    try {
      existing = await readFile(filePath, 'utf8');
    } catch {
      throw new Error(
        `[aliyun-generate] missing generated template: ${path.relative(root, filePath)}`,
      );
    }
    if (existing !== content) {
      throw new Error(
        `[aliyun-generate] stale generated template: ${path.relative(root, filePath)}`,
      );
    }
    return;
  }
  await writeFile(filePath, content);
}

if (definitions.format !== 'otto-aliyun-plan-definitions-v1') {
  throw new Error('[aliyun-generate] unsupported plan definition format');
}

await mkdir(outputDirectory, { recursive: true });
for (const [planName, plan] of Object.entries(definitions.plans)) {
  const template = buildTemplate(planName, plan);
  const outputPath = path.join(outputDirectory, plan.templateFile);
  await writeOrCheck(outputPath, `${JSON.stringify(template, null, 2)}\n`);
}

console.log(
  `[aliyun-generate] ${checkOnly ? 'verified' : 'generated'} ${Object.keys(definitions.plans).length} ROS templates`,
);
