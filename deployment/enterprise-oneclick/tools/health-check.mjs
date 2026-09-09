#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(message);
}

export async function fetchHealthJson(
  url,
  { headers, deadline = performance.now() + 30_000, fetchImpl = fetch } = {},
) {
  const controller = new AbortController();
  let reader;
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new Error('health deadline exceeded'));
      },
      Math.max(0, deadline - performance.now()),
    );
  });
  try {
    if (performance.now() >= deadline) fail('health deadline exceeded');
    const response = await Promise.race([
      fetchImpl(url, {
        headers,
        redirect: 'error',
        signal: controller.signal,
      }),
      expiry,
    ]);
    if (new URL(response.url).href !== new URL(url).href) {
      fail('health response URL changed');
    }
    if (!response.ok) fail('health response HTTP failure');
    if (Number(response.headers.get('content-length')) > 1024 * 1024)
      fail('health response exceeds size limit');
    reader = response.body?.getReader();
    if (!reader) fail('health response has no body');
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), expiry]);
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) fail('health response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail('health response is not JSON');
    }
  } catch (error) {
    // Never echo server bodies, fetch errors, URLs or credentials into release logs.
    if (
      error instanceof Error &&
      /^health (deadline exceeded|response (URL changed|HTTP failure|exceeds size limit|has no body|is not JSON))$/.test(
        error.message,
      )
    )
      throw error;
    fail('health request failed');
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

export function validateSmsConfiguration(env, required = true) {
  const missing = [
    'ALIYUN_SMS_ACCESS_KEY_ID',
    'ALIYUN_SMS_ACCESS_KEY_SECRET',
    'ALIYUN_SMS_SIGN_NAME',
    'ALIYUN_SMS_TEMPLATE_ID',
  ].filter((key) => !env[key]?.trim());
  if (required && missing.length)
    fail(`SMS configuration is incomplete: ${missing.join(', ')}`);
  return { required };
}

export async function runHealthChecks({
  baseUrl,
  expectedVersion,
  expectedBuild,
  expectedSchema,
  env = process.env,
  sms = validateSmsConfiguration(env),
  deadline = performance.now() + 30_000,
}) {
  if (
    !baseUrl ||
    !expectedVersion ||
    !expectedBuild ||
    !Number.isInteger(expectedSchema)
  ) {
    fail(
      'usage: health-check.mjs <base-url> <version> <build-id> <schema> [allow-sms-disabled]',
    );
  }

  const requiredCapabilities = [
    'password_auth',
    'sms_registration',
    'personal_enterprise_upgrade',
    'organization_invites',
    'usage_summary',
    'admin_console',
    'direct_messages',
    'atoa',
    'position_invites',
    'park_service_push',
    'park_repair_v1',
    'park_carpool_v1',
    'data_protection_v1',
    'encrypted_attachment_storage_v1',
    'encrypted_message_storage_v1',
    'signed_telemetry_transport_v1',
    'data_governance_v1',
    'privacy_self_service',
  ];

  const publicHealth = await fetchHealthJson(`${baseUrl}/enterprise/health`, {
    deadline,
  });
  const publicLegal = await fetchHealthJson(`${baseUrl}/enterprise/legal`, {
    deadline,
  });
  const legalDocuments = Array.isArray(publicLegal)
    ? publicLegal
    : publicLegal?.documents;
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !publicHealth.capabilities?.includes(capability),
  );
  const expectedPublicFields = [
    'apiVersion',
    'appVersion',
    'capabilities',
    'service',
    'status',
    'version',
  ];
  const actualPublicFields = Object.keys(publicHealth).sort();

  if (
    publicHealth.status !== 'ok' ||
    publicHealth.service !== 'otto-enterprise' ||
    publicHealth.apiVersion !== 4 ||
    publicHealth.version !== expectedVersion ||
    publicHealth.appVersion !== expectedVersion ||
    missingCapabilities.length > 0
  ) {
    fail('public health identity mismatch');
  }
  if (
    JSON.stringify(actualPublicFields) !== JSON.stringify(expectedPublicFields)
  ) {
    fail('public health fields are not the exact compatibility contract');
  }
  if (!Array.isArray(legalDocuments) || legalDocuments.length < 2) {
    fail('public legal documents are missing');
  }
  for (const document of legalDocuments) {
    const documentHash =
      typeof document?.hash === 'string' ? document.hash : document?.sha256;
    if (
      typeof document?.id !== 'string' ||
      !document.id ||
      typeof document?.version !== 'string' ||
      !document.version ||
      !/^[0-9a-f]{64}$/.test(documentHash || '')
    ) {
      fail('public legal document identity is invalid');
    }
  }

  const configuredBuild = env.OTTO_BUILD_COMMIT?.trim();
  if (configuredBuild !== expectedBuild) {
    fail('runtime build configuration mismatch');
  }

  const adminToken = env.OTTO_ENTERPRISE_ADMIN_TOKEN?.trim();
  if (!adminToken)
    fail(
      'OTTO_ENTERPRISE_ADMIN_TOKEN is required for private health verification',
    );
  const deploymentStatus = await fetchHealthJson(
    `${baseUrl}/enterprise/deployment/status`,
    {
      headers: { 'x-otto-admin-token': adminToken },
      deadline,
    },
  );
  if (
    deploymentStatus.runtime?.version !== expectedVersion ||
    deploymentStatus.runtime?.buildCommit !== expectedBuild
  ) {
    fail('authenticated runtime identity mismatch');
  }
  if (deploymentStatus.license?.enforce !== true) {
    fail('deployment License enforcement is not active');
  }
  if (
    env.OTTO_ENTERPRISE_DEPLOYMENT_GRANTS?.trim() &&
    !['active', 'expiring', 'grace'].includes(deploymentStatus.license?.status)
  ) {
    fail(
      'configured deployment grants require a usable signed deployment License',
    );
  }
  if (
    deploymentStatus.database?.ready !== true ||
    deploymentStatus.database?.schemaVersion !== expectedSchema
  ) {
    fail('private database readiness mismatch');
  }
  if (deploymentStatus.operationsSecurity?.sqlCipher?.state !== 'active') {
    fail('SQLCipher encryption is not active');
  }

  return {
    ok: true,
    health: publicHealth,
    legalDocuments: legalDocuments.map(({ id, version }) => ({ id, version })),
    database: {
      schemaVersion: expectedSchema,
      integrity: 'verified-during-migration',
      encryption: 'sqlcipher',
    },
    licenseEnforced: true,
    smsRequired: sms.required,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [url, expectedVersion, expectedBuild, schema, mode] = argv;
  const result = await runHealthChecks({
    baseUrl: url?.replace(/\/+$/, ''),
    expectedVersion,
    expectedBuild,
    expectedSchema: Number(schema),
    env,
    sms: validateSmsConfiguration(env, mode !== 'allow-sms-disabled'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`[Otto Health] ${error.message}\n`);
    process.exitCode = 5;
  });
}
