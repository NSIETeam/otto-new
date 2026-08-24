import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const contractPath = path.join(
  root,
  'deployment/aliyun/otto-compute-nest-contract.json',
);
const validator = path.join(
  root,
  'scripts/validate-aliyun-deployment-contract.mjs',
);
const generator = path.join(root, 'scripts/generate-aliyun-ros-templates.mjs');
const secretScanner = path.join(
  root,
  'scripts/scan-aliyun-deployment-secrets.mjs',
);

async function validate(contract) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'otto-aliyun-contract-'),
  );
  const file = path.join(directory, 'contract.json');
  await writeFile(file, JSON.stringify(contract));
  return run(process.execPath, [validator, file]);
}

describe('Aliyun deployment contract', () => {
  it('validates the local contract without cloud credentials', async () => {
    const { stdout } = await run(process.execPath, [validator, contractPath]);
    expect(stdout).toContain('templates=3');
    expect(stdout).toContain('realDeploymentEnabled=false');
  });
  it('keeps committed ROS templates generated from one plan definition', async () => {
    const { stdout } = await run(process.execPath, [generator, '--check']);
    expect(stdout).toContain('verified 3 ROS templates');
  });
  it('passes the deployment-specific secret scan', async () => {
    const { stdout } = await run(process.execPath, [secretScanner]);
    expect(stdout).toContain('clean: 3 template(s)');
  });
  it('rejects a public database or plaintext secret output', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    contract.plans.standard.postgres.public = true;
    await expect(validate(contract)).rejects.toThrow(/must be private/);
    contract.plans.standard.postgres.public = false;
    contract.outputs.allowed.push('password');
    await expect(validate(contract)).rejects.toThrow(/secret-like field/);
  });
  it('rejects a contract that enables real cloud deployment locally', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    contract.realDeploymentEnabled = true;
    await expect(validate(contract)).rejects.toThrow(
      /must not enable real cloud/,
    );
  });
  it('rejects HTTP-only public entry or replay resource creation', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    contract.network.tls.httpsRequired = false;
    await expect(validate(contract)).rejects.toThrow(/TLS/);
    contract.network.tls.httpsRequired = true;
    contract.idempotency.replayMustNotCreateResources = false;
    await expect(validate(contract)).rejects.toThrow(/replays/);
  });
  it('rejects a public object store in a generated template', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    const templatePath = path.join(root, contract.templates.files.trial);
    const template = JSON.parse(await readFile(templatePath, 'utf8'));
    template.Resources.ObjectStorage.Properties.BlockPublicAccess = false;
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'otto-aliyun-template-'),
    );
    const file = path.join(directory, 'trial.json');
    await writeFile(file, JSON.stringify(template));
    contract.templates.files.trial = file;
    await expect(validate(contract)).rejects.toThrow(
      /OSS must block public access/,
    );
  });
  it('rejects plaintext credentials and credential-bearing URLs', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    const templatePath = path.join(root, contract.templates.files.trial);
    const template = JSON.parse(await readFile(templatePath, 'utf8'));
    template.Resources.Cache.Properties.Password =
      'sk-test-credential-12345678901234567890';
    template.Metadata.Otto.Callback =
      'https://otto:plaintext@example.invalid/callback';
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'otto-aliyun-secret-'),
    );
    const file = path.join(directory, 'template.json');
    await writeFile(file, JSON.stringify(template));
    await expect(run(process.execPath, [secretScanner, file])).rejects.toThrow(
      /credential|encrypted reference/,
    );
  });

  it('generates a dual-zone ALB HTTPS edge without exposing Otto directly', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    for (const templateFile of Object.values(contract.templates.files)) {
      const template = JSON.parse(
        await readFile(path.join(root, templateFile), 'utf8'),
      );
      const resources = Object.values(template.Resources);
      const alb = resources.find(
        (resource) => resource.Type === 'ALIYUN::ALB::LoadBalancer',
      );
      const listener = resources.find(
        (resource) => resource.Type === 'ALIYUN::ALB::Listener',
      );
      const serverGroup = resources.find(
        (resource) => resource.Type === 'ALIYUN::ALB::ServerGroup',
      );
      const attachment = resources.find(
        (resource) => resource.Type === 'ALIYUN::ALB::BackendServerAttachment',
      );
      const dnsRecord = resources.find(
        (resource) => resource.Type === 'ALIYUN::DNS::DomainRecord',
      );

      expect(alb?.Properties).toMatchObject({
        AddressType: 'Internet',
        AddressIpVersion: 'IPv4',
      });
      expect(alb?.Properties.ZoneMappings).toHaveLength(2);
      expect(template.Parameters.DomainName.MaxLength).toBe(80);
      expect(listener?.Properties).toMatchObject({
        ListenerPort: 443,
        ListenerProtocol: 'HTTPS',
        SecurityPolicyId: 'tls_cipher_policy_1_2_strict_with_1_3',
        Certificates: [{ CertificateId: { Ref: 'TlsCertificateId' } }],
        XForwardedForConfig: {
          XForwardedForEnabled: true,
          XForwardedForProcessingMode: 'append',
          XForwardedForProtoEnabled: true,
          XForwardedForHostEnabled: false,
        },
      });
      expect(serverGroup?.Properties.HealthCheckConfig).toMatchObject({
        HealthCheckConnectPort: 7777,
        HealthCheckPath: '/enterprise/health',
        HealthCheckHost: { Ref: 'DomainName' },
        HealthCheckProtocol: 'HTTP',
      });
      if (alb.Properties.LoadBalancerEdition === 'Basic') {
        expect(serverGroup.Properties).not.toHaveProperty(
          'ConnectionDrainConfig',
        );
      } else {
        expect(serverGroup.Properties.ConnectionDrainConfig).toEqual({
          ConnectionDrainEnabled: true,
          ConnectionDrainTimeout: 60,
        });
      }
      expect(attachment?.Properties.Servers.length).toBeGreaterThanOrEqual(1);
      expect(
        attachment.Properties.Servers.every(
          (server) => server.Port === 7777 && server.ServerType === 'Ecs',
        ),
      ).toBe(true);
      expect(dnsRecord?.Properties).toMatchObject({
        DomainName: { Ref: 'DnsZoneName' },
        RR: { Ref: 'DnsRecordRr' },
        Type: 'CNAME',
      });

      const publicIngress = resources.filter(
        (resource) =>
          resource.Type === 'ALIYUN::ECS::SecurityGroupIngress' &&
          ['0.0.0.0/0', '::/0'].includes(resource.Properties.SourceCidrIp),
      );
      expect(
        publicIngress.every(
          (resource) => resource.Properties.PortRange === '443/443',
        ),
      ).toBe(true);
      expect(
        resources
          .filter((resource) => resource.Type === 'ALIYUN::ECS::InstanceGroup')
          .every(
            (resource) =>
              resource.Properties.AllocatePublicIP === false &&
              resource.Properties.InternetMaxBandwidthOut === 0,
          ),
      ).toBe(true);
    }
  });

  it('rejects an insecure or direct-public CLOUD-03 edge', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    const templatePath = path.join(root, contract.templates.files.trial);
    const template = JSON.parse(await readFile(templatePath, 'utf8'));
    template.Resources.HttpsListener.Properties.SecurityPolicyId =
      'tls_cipher_policy_1_0';
    template.Resources.AlbPrimaryServiceIngress.Properties.SourceCidrIp =
      '0.0.0.0/0';
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'otto-aliyun-edge-'),
    );
    const file = path.join(directory, 'trial.json');
    await writeFile(file, JSON.stringify(template));
    contract.templates.files.trial = file;
    await expect(validate(contract)).rejects.toThrow(
      /TLS security policy|exposes a forbidden public port/,
    );
  });
});
