/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CURRENT_LEGAL_DOCUMENTS,
  currentLegalDocumentReferences,
  dataGovernanceConfiguration,
  dataProcessingInventory,
  legalDocumentHash,
} from '../modules/data_governance/index.js';
import {
  publicKeyId,
  signEd25519Envelope,
} from '../modules/commercial_control/index.js';
import { createClusteredEnterpriseServer } from './clusteredServer.js';
import type { ClusteredEnterpriseSharedState } from './clusteredSharedState.js';
import type {
  PostgresEnterpriseAccountView,
  PostgresEnterpriseCoreRepository,
} from './postgresCoreRepository.js';
import type { PostgresBusinessRecord } from './postgresBusinessRepository.js';

const account: PostgresEnterpriseAccountView = {
  id: 'acc_admin',
  organizationId: 'org_default',
  organizationName: 'Otto',
  accountType: 'enterprise',
  employeeId: null,
  username: 'admin',
  phone: null,
  feishuOpenId: null,
  name: 'Administrator',
  role: 'Administrator',
  department: 'IT',
  departmentId: null,
  positionId: null,
  positionTitle: null,
  avatarUrl: null,
  isAdmin: true,
  status: 'active',
  tags: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};
const peerAccount: PostgresEnterpriseAccountView = {
  ...account,
  id: 'acc_peer',
  username: 'peer',
  name: 'Peer',
  isAdmin: false,
};

const licenseKeyPair = generateKeyPairSync('ed25519');
const licensePrivateKey = licenseKeyPair.privateKey
  .export({
    format: 'pem',
    type: 'pkcs8',
  })
  .toString();
const licensePublicKey = licenseKeyPair.publicKey
  .export({
    format: 'pem',
    type: 'spki',
  })
  .toString();

function activeLicenseRecord(overrides: Record<string, unknown> = {}) {
  const payload = {
    id: 'lic_clustered_test',
    deploymentId: 'clustered-enterprise',
    organizationId: account.organizationId,
    plan: 'enterprise',
    expiresAt: '2099-08-01T00:00:00.000Z',
    seatLimit: 10,
    modules: [
      'enterprise_tree',
      'direct_messages',
      'atoa',
      'knowledge',
      'skill_market',
      'park_service',
    ],
    offline: true,
    ...overrides,
  };
  return {
    organizationId: account.organizationId,
    domain: 'commercial_control' as const,
    resourceType: 'license',
    resourceId: 'current',
    ownerAccountId: account.id,
    status: 'active',
    version: 1,
    payload: {
      signedEnvelope: {
        payload,
        signature: signEd25519Envelope(payload, licensePrivateKey),
        signingKeyId: publicKeyId(licensePublicKey),
      },
      expiresAt: payload.expiresAt,
      seatLimit: payload.seatLimit,
      modules: payload.modules,
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function repository(
  licenseRecord: ReturnType<
    typeof activeLicenseRecord
  > | null = activeLicenseRecord(),
): PostgresEnterpriseCoreRepository {
  const getDataGovernanceProfile = vi.fn(async () => ({
    ...dataGovernanceConfiguration(),
    documents: CURRENT_LEGAL_DOCUMENTS.map((document) => ({
      ...document,
      hash: legalDocumentHash(document),
      accepted: false,
      acceptedAt: null,
    })),
    processingActivities: dataProcessingInventory(),
    rights: [],
    currentConsentComplete: false,
  }));
  return {
    defaultOrganizationId: 'org_default',
    readiness: vi.fn(async () => ({
      ready: true,
      backend: 'postgresql',
      schemaVersion: 4,
      organizations: 1,
      accounts: 1,
    })),
    authenticateAccount: vi.fn(async (identifier: string, password: string) =>
      identifier === 'admin' && password === 'correct-password'
        ? account
        : null,
    ),
    getLoginRetryAfter: vi.fn(async () => 0),
    recordLoginFailure: vi.fn(async () => 0),
    clearLoginFailures: vi.fn(async () => undefined),
    logAudit: vi.fn(async () => undefined),
    createAuthSession: vi.fn(async () => ({
      token: 'clustered-session-token',
      expiresAt: '2026-09-01T00:00:00.000Z',
    })),
    getAccountBySession: vi.fn(async (token: string) =>
      token === 'clustered-session-token'
        ? account
        : token === 'peer-session-token'
          ? peerAccount
          : null,
    ),
    revokeAuthSession: vi.fn(async () => true),
    getOrganizationFeatures: vi.fn(async () => ({
      enterprise_tree: true,
      direct_messages: true,
      atoa: true,
      park_services: true,
      knowledge: true,
      skill_market: true,
    })),
    updateOrganizationFeatures: vi.fn(async (_organizationId, patch) => ({
      enterprise_tree: patch.enterprise_tree ?? true,
      direct_messages: patch.direct_messages ?? true,
      atoa: patch.atoa ?? true,
      park_services: patch.park_services ?? true,
      knowledge: patch.knowledge ?? true,
      skill_market: patch.skill_market ?? true,
    })),
    listAccountSyncSnapshots: vi.fn(async () => []),
    putAccountSyncSnapshot: vi.fn(async (input) => ({
      scope: input.scope,
      version: input.expectedVersion + 1,
      payload: input.payload,
      payloadHash: 'a'.repeat(64),
      deviceId: input.deviceId ?? null,
      updatedAtMs: Date.parse('2026-08-01T00:00:00.000Z'),
    })),
    listBusinessRecords: vi.fn(async () => []),
    getBusinessRecord: vi.fn(
      async (input: {
        domain: string;
        resourceType: string;
        resourceId: string;
      }) =>
        input.domain === 'commercial_control' &&
        input.resourceType === 'license' &&
        input.resourceId === 'current'
          ? licenseRecord
          : null,
    ),
    createBusinessRecord: vi.fn(async (input) => ({
      organizationId: input.organizationId,
      domain: input.domain,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? 'resource-1',
      ownerAccountId: input.ownerAccountId ?? null,
      status: input.status ?? 'active',
      version: 1,
      payload: input.payload,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })),
    updateBusinessRecord: vi.fn(async () => null),
    appendBusinessEvent: vi.fn(async (input) => ({
      organizationId: input.organizationId,
      domain: input.domain,
      eventId: input.eventId ?? 'event-1',
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      actorAccountId: input.actorAccountId ?? null,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: '2026-08-01T00:00:00.000Z',
      inserted: true,
    })),
    listBusinessEvents: vi.fn(async () => []),
    findActiveParkInvite: vi.fn(async () => null),
    listParkTenantMemberships: vi.fn(async () => []),
    listTicketRecordsForAccount: vi.fn(async () => []),
    listAddressedBusinessRecords: vi.fn(async () => []),
    exportAccountData: vi.fn(async (target) => ({
      format: 'otto-account-export-v1',
      account: target,
    })),
    deleteOwnAccountData: vi.fn(async (target) => ({
      accountId: target.id,
      deletedAt: '2026-08-01T00:00:00.000Z',
      mode: 'cryptographic_and_soft_delete' as const,
    })),
    getDataGovernanceProfile,
    recordCurrentLegalConsent: vi.fn(async () => undefined),
    getAccount: vi.fn(async (id: string) =>
      id === peerAccount.id ? peerAccount : id === account.id ? account : null,
    ),
    listUnreadE2eeNotifications: vi.fn(async () => []),
    listE2eeDirectMessages: vi.fn(async () => []),
    getOrganization: vi.fn(async (id: string) =>
      id === account.organizationId
        ? {
            id,
            name: account.organizationName,
            slug: 'otto',
            parkId: null,
            status: 'active' as const,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          }
        : null,
    ),
    listAccounts: vi.fn(async (organizationId: string) =>
      organizationId === account.organizationId ? [account, peerAccount] : [],
    ),
    listOrganizationStructure: vi.fn(async () => []),
  } as unknown as PostgresEnterpriseCoreRepository;
}

const servers: Array<
  ReturnType<typeof createClusteredEnterpriseServer>['server']
> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function listen(
  repo = repository(),
  options: NonNullable<
    Parameters<typeof createClusteredEnterpriseServer>[1]
  > = {},
) {
  const created = createClusteredEnterpriseServer(repo, {
    host: '127.0.0.1',
    port: 0,
    adminToken: 'system-admin-token',
    appVersion: '1.9.10',
    buildCommit: 'a'.repeat(40),
    licensePublicKeys: [licensePublicKey],
    ...options,
  });
  servers.push(created.server);
  await new Promise<void>((resolve) =>
    created.server.listen(0, '127.0.0.1', resolve),
  );
  const address = created.server.address() as AddressInfo;
  return {
    repo,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

describe('clustered PostgreSQL enterprise server', () => {
  it('publishes only the public compatibility contract while probing PostgreSQL readiness', async () => {
    const { baseUrl } = await listen();
    const response = await fetch(`${baseUrl}/enterprise/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'ok',
      service: 'otto-enterprise',
      apiVersion: 4,
      capabilities: expect.arrayContaining([
        'sms_registration',
        'personal_registration',
        'data_governance_v1',
      ]),
    });
    expect(Object.keys(body).sort()).toEqual([
      'apiVersion',
      'appVersion',
      'capabilities',
      'service',
      'status',
      'version',
    ]);
  });

  it('does not expose clustered readiness details through the public health route', async () => {
    const repo = repository();
    repo.readiness = vi.fn(async () => {
      throw new Error(
        'PostgreSQL schema version 23 does not match current version 24; secret=/etc/otto-enterprise/private.env',
      );
    });
    const { baseUrl } = await listen(repo);
    const response = await fetch(`${baseUrl}/enterprise/health`);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      status: 'unavailable',
      service: 'otto-enterprise',
      apiVersion: 4,
      version: '1.9.10',
      appVersion: '1.9.10',
      capabilities: [],
      error: 'enterprise service unavailable',
    });
    expect(JSON.stringify(body)).not.toMatch(
      /schema|23|24|secret|private\.env|\/etc\//i,
    );
  });

  it('does not expose repository details through the public legal route', async () => {
    const repo = repository();
    repo.getDataGovernanceProfile = vi.fn(async () => {
      throw new Error(
        'database operation failed at /etc/otto-enterprise/private.env?token=secret',
      );
    });
    const { baseUrl } = await listen(repo);
    const response = await fetch(`${baseUrl}/enterprise/legal`);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      error: 'enterprise legal documents unavailable',
    });
    expect(JSON.stringify(body)).not.toMatch(
      /database|token|secret|private\.env/i,
    );
  });

  it('serves password login and session lookup from the async repository', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const login = await fetch(`${baseUrl}/enterprise/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'admin',
        password: 'correct-password',
      }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({
      account: { id: 'acc_admin', organizationId: 'org_default' },
      token: 'clustered-session-token',
    });

    const me = await fetch(`${baseUrl}/enterprise/auth/me`, {
      headers: { authorization: 'Bearer clustered-session-token' },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ account: { username: 'admin' } });
    expect(repo.authenticateAccount).toHaveBeenCalledWith(
      'admin',
      'correct-password',
    );
    expect(repo.clearLoginFailures).toHaveBeenCalledWith('admin');
  });

  it('fails closed for missing, expired, unlicensed, and over-seat business execution', async () => {
    const authorization = 'Bearer clustered-session-token';
    const cases = [
      {
        repository: repository(null),
        path: '/enterprise/knowledge',
        code: 'deployment_license_inactive',
      },
      {
        repository: repository(null),
        path: '/enterprise/accounts',
        code: 'deployment_license_inactive',
      },
      {
        repository: repository(null),
        path: '/enterprise/organization/invite',
        code: 'deployment_license_inactive',
      },
      {
        repository: repository(null),
        path: '/enterprise/organization/view',
        code: 'deployment_license_inactive',
      },
      {
        repository: repository(
          activeLicenseRecord({ expiresAt: '2020-01-01T00:00:00.000Z' }),
        ),
        path: '/enterprise/tickets',
        code: 'deployment_license_inactive',
      },
      {
        repository: repository(
          activeLicenseRecord({ organizationId: 'org_other_tenant' }),
        ),
        path: '/enterprise/knowledge',
        code: 'deployment_license_inactive',
      },
      {
        repository: repository(
          activeLicenseRecord({ modules: ['enterprise_tree'] }),
        ),
        path: '/enterprise/skills',
        code: 'commercial_module_not_entitled',
      },
      {
        repository: repository(activeLicenseRecord({ seatLimit: 1 })),
        path: '/enterprise/attachments/inline',
        code: 'deployment_seat_limit_exceeded',
      },
    ];
    for (const testCase of cases) {
      const { baseUrl } = await listen(testCase.repository);
      const response = await fetch(`${baseUrl}${testCase.path}`, {
        headers: { authorization },
      });
      expect(response.status, testCase.path).toBe(402);
      await expect(response.json()).resolves.toMatchObject({
        code: testCase.code,
        license: { enforce: true },
      });
      expect(testCase.repository.logAudit).toHaveBeenCalledWith(
        'commercial_license_denied',
        account.organizationId,
        account.employeeId,
        expect.objectContaining({
          actorAccountId: account.id,
          code: testCase.code,
        }),
      );
    }

    const { baseUrl } = await listen(repository(null));
    const me = await fetch(`${baseUrl}/enterprise/auth/me`, {
      headers: { authorization },
    });
    expect(me.status).toBe(200);
    const exported = await fetch(`${baseUrl}/enterprise/privacy/export`, {
      headers: { authorization },
    });
    expect(exported.status).toBe(200);
  });

  it('does not advertise or execute SQLite Control bootstrap in clustered mode', async () => {
    const { baseUrl } = await listen();
    const health = await fetch(`${baseUrl}/enterprise/health`);
    const snapshot = (await health.json()) as { capabilities: string[] };
    expect(snapshot.capabilities).not.toContain(
      'private_deployment_bootstrap_v1',
    );

    const prepare = await fetch(`${baseUrl}/enterprise/bootstrap/prepare`, {
      method: 'POST',
      headers: { authorization: 'Bearer clustered-session-token' },
    });
    expect(prepare.status).toBe(503);
    await expect(prepare.json()).resolves.toMatchObject({
      code: 'POSTGRES_ROUTE_NOT_MIGRATED',
      path: '/enterprise/bootstrap/prepare',
    });
  });

  it('reports expanded entitlements with the same capability rule used by clustered route admission', async () => {
    const repo = repository(
      activeLicenseRecord({ modules: ['enterprise_tree'] }),
    );
    const { baseUrl } = await listen(repo);
    const headers = { authorization: 'Bearer clustered-session-token' };

    const response = await fetch(
      `${baseUrl}/enterprise/organization/features`,
      { headers },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      entitled: {
        enterprise_tree: true,
        knowledge: true,
      },
      effective: {
        enterprise_tree: true,
        knowledge: true,
      },
    });

    const knowledge = await fetch(`${baseUrl}/enterprise/knowledge`, {
      headers,
    });
    expect(knowledge.status).toBe(200);
  });

  it('rejects licensed clustered routes when the organization switch is disabled', async () => {
    const repo = repository();
    repo.getOrganizationFeatures = vi.fn(async () => ({
      enterprise_tree: false,
      direct_messages: false,
      atoa: false,
      park_services: false,
      knowledge: false,
      skill_market: false,
    }));
    const { baseUrl } = await listen(repo);
    const headers = { authorization: 'Bearer clustered-session-token' };

    for (const [path, feature] of [
      ['/enterprise/organization/departments', 'enterprise_tree'],
      ['/enterprise/organization/public-profile', 'park_service'],
      ['/enterprise/federation/contacts', 'direct_messages'],
      ['/enterprise/atoa/tasks', 'atoa'],
      ['/enterprise/knowledge', 'knowledge'],
      ['/enterprise/skills', 'skill_market'],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, { headers });
      expect(response.status, path).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: 'organization_feature_disabled',
        feature,
      });
    }
  });

  it.each(['atoa_request', 'atoa_response'] as const)(
    'rejects %s messages when A2A is licensed but disabled by the organization',
    async (contentType) => {
      const repo = repository();
      const sendE2eeDirectMessage = vi.fn();
      repo.sendE2eeDirectMessage =
        sendE2eeDirectMessage as unknown as typeof repo.sendE2eeDirectMessage;
      repo.getOrganizationFeatures = vi.fn(async () => ({
        enterprise_tree: true,
        direct_messages: true,
        atoa: false,
        park_services: true,
        knowledge: true,
        skill_market: true,
      }));
      const { baseUrl } = await listen(repo);

      const response = await fetch(
        `${baseUrl}/enterprise/messages/${peerAccount.id}`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer clustered-session-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messageId: `message-${contentType}`,
            senderDeviceId: 'device-admin',
            protocolVersion: 1,
            contentType,
            ciphertext: 'encrypted',
            nonce: 'nonce',
            signature: 'signature',
            envelopes: [],
          }),
        },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: 'organization_feature_disabled',
        feature: 'atoa',
      });
      expect(sendE2eeDirectMessage).not.toHaveBeenCalled();
    },
  );

  it('rejects a park ticket when the park administrator organization disables park_service', async () => {
    const targetOrganizationId = 'org_park_admin';
    const targetAccount: PostgresEnterpriseAccountView = {
      ...account,
      id: 'acc_park_admin',
      organizationId: targetOrganizationId,
      organizationName: 'Park Admin',
      username: 'park-admin',
      name: 'Park Administrator',
    };
    const sourceLicense = activeLicenseRecord();
    const targetLicense = {
      ...activeLicenseRecord({ organizationId: targetOrganizationId }),
      organizationId: targetOrganizationId,
    };
    const membership: PostgresBusinessRecord<Record<string, unknown>> = {
      organizationId: account.organizationId,
      domain: 'park',
      resourceType: 'membership',
      resourceId: `membership_${account.organizationId}`,
      ownerAccountId: account.id,
      status: 'active',
      version: 1,
      payload: {
        parkId: 'park-admin',
        adminOrganizationId: targetOrganizationId,
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    const park: PostgresBusinessRecord<Record<string, unknown>> = {
      organizationId: targetOrganizationId,
      domain: 'park',
      resourceType: 'park',
      resourceId: 'park-admin',
      ownerAccountId: targetAccount.id,
      status: 'active',
      version: 1,
      payload: {
        name: 'Otto Park',
        address: null,
        adminOrganizationId: targetOrganizationId,
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    const repo = repository();
    repo.getBusinessRecord = vi.fn(
      async (input: {
        organizationId: string;
        domain: string;
        resourceType: string;
        resourceId: string;
      }) => {
        if (
          input.domain === 'commercial_control' &&
          input.resourceType === 'license' &&
          input.resourceId === 'current'
        ) {
          return input.organizationId === targetOrganizationId
            ? targetLicense
            : sourceLicense;
        }
        if (
          input.organizationId === account.organizationId &&
          input.domain === 'park' &&
          input.resourceType === 'membership'
        ) {
          return membership;
        }
        if (
          input.organizationId === targetOrganizationId &&
          input.domain === 'park' &&
          input.resourceType === 'park' &&
          input.resourceId === park.resourceId
        ) {
          return park;
        }
        return null;
      },
    ) as unknown as typeof repo.getBusinessRecord;
    repo.listAccounts = vi.fn(async (organizationId: string) =>
      organizationId === targetOrganizationId
        ? [targetAccount]
        : [account, peerAccount],
    );
    repo.getOrganizationFeatures = vi.fn(async (organizationId: string) => ({
      enterprise_tree: true,
      direct_messages: true,
      atoa: true,
      park_services: organizationId !== targetOrganizationId,
      knowledge: true,
      skill_market: true,
    }));
    const { baseUrl } = await listen(repo);

    const response = await fetch(`${baseUrl}/enterprise/tickets`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        serviceId: 'repair',
        title: 'Park administrator disabled service',
        description: 'This request must not be persisted.',
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'organization_feature_disabled',
      feature: 'park_service',
    });
    expect(repo.getOrganizationFeatures).toHaveBeenCalledWith(
      targetOrganizationId,
    );
    expect(repo.createBusinessRecord).not.toHaveBeenCalled();
    expect(repo.appendBusinessEvent).not.toHaveBeenCalled();
  });

  it('serves the desktop department-list contract only when enterprise_tree is effective', async () => {
    const repo = repository();
    const timestamp = '2026-08-01T00:00:00.000Z';
    const structure = {
      departments: [
        {
          id: 'dept-research',
          organizationId: 'org_default',
          name: '研发部',
          parentDepartmentId: null,
          memberCount: 2,
          positions: [
            {
              id: 'position-engineer',
              organizationId: 'org_default',
              departmentId: 'dept-research',
              title: '工程师',
              roleMapping: 'member',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
    repo.listOrganizationStructure = vi.fn(async () => structure);
    const { baseUrl } = await listen(repo);

    const response = await fetch(
      `${baseUrl}/enterprise/organization/departments`,
      { headers: { authorization: 'Bearer clustered-session-token' } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      structure: structure.departments,
    });
    expect(repo.listOrganizationStructure).toHaveBeenCalledWith('org_default');
  });

  it('loads an authorized park tenant from the target organization without leaking clustered storage keys', async () => {
    const tenantOrganizationId = 'org_tenant';
    const tenantAccount: PostgresEnterpriseAccountView = {
      ...peerAccount,
      id: 'acc_tenant',
      organizationId: tenantOrganizationId,
      organizationName: 'Tenant Ltd',
      username: 'tenant',
      name: 'Tenant Member',
    };
    const tenantOrganization = {
      id: tenantOrganizationId,
      name: 'Tenant Ltd',
      slug: 'tenant-ltd',
      parkId: 'park-1',
      status: 'active' as const,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    const tenantStructure = {
      departments: [
        {
          id: 'dept-tenant',
          organizationId: tenantOrganizationId,
          name: '租户部门',
          parentDepartmentId: null,
          memberCount: 1,
          positions: [],
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
        },
      ],
    };
    const membership: PostgresBusinessRecord<Record<string, unknown>> = {
      organizationId: tenantOrganizationId,
      domain: 'park',
      resourceType: 'membership',
      resourceId: `membership_${tenantOrganizationId}`,
      ownerAccountId: null,
      status: 'active',
      version: 1,
      payload: {
        parkId: 'park-1',
        adminOrganizationId: account.organizationId,
        address: 'B座',
        roomNumber: '1201',
        joinedAt: account.createdAt,
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    const park: PostgresBusinessRecord<Record<string, unknown>> = {
      organizationId: account.organizationId,
      domain: 'park',
      resourceType: 'park',
      resourceId: 'park-1',
      ownerAccountId: account.id,
      status: 'active',
      version: 1,
      payload: {
        name: '宏创园区',
        slug: 'hongchuang-park',
        brandName: '宏创园区服务',
        adminOrganizationId: account.organizationId,
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    const tenantLicense = {
      ...activeLicenseRecord({ organizationId: tenantOrganizationId }),
      organizationId: tenantOrganizationId,
    };
    const repo = repository();
    repo.listParkTenantMemberships = vi.fn(async () => [membership]);
    repo.getOrganization = vi.fn(async (organizationId: string) =>
      organizationId === tenantOrganizationId
        ? tenantOrganization
        : organizationId === account.organizationId
          ? {
              id: account.organizationId,
              name: account.organizationName,
              slug: 'otto',
              parkId: null,
              status: 'active' as const,
              createdAt: account.createdAt,
              updatedAt: account.updatedAt,
            }
          : null,
    );
    repo.listAccounts = vi.fn(async (organizationId: string) =>
      organizationId === tenantOrganizationId
        ? [tenantAccount]
        : organizationId === account.organizationId
          ? [account, peerAccount]
          : [],
    );
    repo.listOrganizationStructure = vi.fn(async (organizationId: string) =>
      organizationId === tenantOrganizationId
        ? tenantStructure
        : { departments: [] },
    );
    repo.getBusinessRecord = vi.fn(
      async (input: {
        organizationId: string;
        domain: string;
        resourceType: string;
        resourceId: string;
      }) => {
        if (
          input.domain === 'commercial_control' &&
          input.resourceType === 'license' &&
          input.resourceId === 'current'
        ) {
          return input.organizationId === tenantOrganizationId
            ? tenantLicense
            : activeLicenseRecord();
        }
        if (
          input.organizationId === tenantOrganizationId &&
          input.domain === 'park' &&
          input.resourceType === 'membership' &&
          input.resourceId === `membership_${tenantOrganizationId}`
        ) {
          return membership;
        }
        if (
          input.organizationId === account.organizationId &&
          input.domain === 'park' &&
          input.resourceType === 'park' &&
          input.resourceId === park.resourceId
        ) {
          return park;
        }
        return null;
      },
    ) as unknown as typeof repo.getBusinessRecord;
    repo.getOrganizationFeatures = vi.fn(async () => ({
      enterprise_tree: true,
      direct_messages: true,
      atoa: true,
      park_services: true,
      knowledge: true,
      skill_market: true,
    }));
    const listAccountPresence = vi.fn(async () => []);
    const sharedState = {
      getAccountBySession: vi.fn(async () => account),
      listAccountPresence,
    } as unknown as ClusteredEnterpriseSharedState;
    const { baseUrl } = await listen(repo, { sharedState });

    const response = await fetch(
      `${baseUrl}/enterprise/organization/view?organizationId=${tenantOrganizationId}`,
      { headers: { authorization: 'Bearer clustered-session-token' } },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      organization: unknown;
      members: unknown[];
      structure: unknown[];
      features: Record<string, boolean>;
      park: Record<string, unknown> | null;
    };
    expect(body).toMatchObject({
      organization: tenantOrganization,
      members: [{ id: tenantAccount.id, organizationId: tenantOrganizationId }],
      structure: tenantStructure.departments,
      features: {
        enterprise_tree: true,
        park_service: true,
      },
      park: {
        id: 'park-1',
        name: '宏创园区',
        slug: 'hongchuang-park',
        brandName: '宏创园区服务',
        adminOrganizationId: account.organizationId,
        isAdminOrganization: false,
        tenantAddress: 'B座',
        tenantRoomNumber: '1201',
      },
    });
    expect(body.features).not.toHaveProperty('park_services');
    expect(repo.listParkTenantMemberships).toHaveBeenCalledWith('org_default');
    expect(repo.listAccounts).toHaveBeenCalledWith(tenantOrganizationId);
    expect(repo.listOrganizationStructure).toHaveBeenCalledWith(
      tenantOrganizationId,
    );
    expect(listAccountPresence).toHaveBeenCalledWith(tenantOrganizationId, [
      tenantAccount.id,
    ]);
  });

  it('returns the real clustered park context that makes the administrator tenant list reachable', async () => {
    const park: PostgresBusinessRecord<Record<string, unknown>> = {
      organizationId: account.organizationId,
      domain: 'park',
      resourceType: 'park',
      resourceId: `park_${account.organizationId}`,
      ownerAccountId: account.id,
      status: 'active',
      version: 1,
      payload: {
        name: '宏创园区',
        slug: 'hongchuang-park',
        brandName: '宏创园区服务',
        adminOrganizationId: account.organizationId,
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    const service: PostgresBusinessRecord<Record<string, unknown>> = {
      organizationId: account.organizationId,
      domain: 'park',
      resourceType: 'service',
      resourceId: 'repair',
      ownerAccountId: account.id,
      status: 'active',
      version: 1,
      payload: {
        name: '物业报修',
        enabled: true,
        config: { category: 'maintenance' },
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    const repo = repository();
    repo.listBusinessRecords = vi.fn(
      async (input: { domain: string; resourceType?: string }) => {
        if (input.domain !== 'park') return [];
        if (input.resourceType === 'park') return [park];
        if (input.resourceType === 'service') return [service];
        return [];
      },
    ) as unknown as typeof repo.listBusinessRecords;
    const defaultGetBusinessRecord = repo.getBusinessRecord;
    repo.getBusinessRecord = vi.fn(
      async (input: {
        organizationId: string;
        domain: string;
        resourceType: string;
        resourceId: string;
      }) => {
        if (
          input.organizationId === account.organizationId &&
          input.domain === 'park' &&
          input.resourceType === 'park' &&
          input.resourceId === park.resourceId
        ) {
          return park;
        }
        return defaultGetBusinessRecord(input);
      },
    ) as unknown as typeof repo.getBusinessRecord;
    const { baseUrl } = await listen(repo);
    const headers = { authorization: 'Bearer clustered-session-token' };

    const response = await fetch(`${baseUrl}/enterprise/organization/view`, {
      headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      park: {
        id: park.resourceId,
        name: '宏创园区',
        slug: 'hongchuang-park',
        brandName: '宏创园区服务',
        adminOrganizationId: account.organizationId,
        isAdminOrganization: true,
        services: [
          {
            parkId: park.resourceId,
            id: service.resourceId,
            name: '物业报修',
            enabled: true,
            config: { category: 'maintenance' },
          },
        ],
        tenantAddress: null,
        tenantRoomNumber: null,
      },
    });

    const tenants = await fetch(`${baseUrl}/enterprise/park/tenants`, {
      headers,
    });
    expect(tenants.status).toBe(200);
    await expect(tenants.json()).resolves.toEqual({ organizations: [] });
  });

  it.each([
    {
      reason: '目标企业缺少许可证',
      targetLicenseModules: null,
      targetConfigured: true,
      expectsTargetConfigurationRead: false,
    },
    {
      reason: '目标企业关闭企业树',
      targetLicenseModules: [
        'enterprise_tree',
        'direct_messages',
        'atoa',
        'knowledge',
        'skill_market',
        'park_service',
      ],
      targetConfigured: false,
      expectsTargetConfigurationRead: true,
    },
  ])(
    'rejects a cross-organization view without leaking target data when $reason',
    async ({
      targetLicenseModules,
      targetConfigured,
      expectsTargetConfigurationRead,
    }) => {
      const tenantOrganizationId = 'org_private_tenant';
      const tenantAccount: PostgresEnterpriseAccountView = {
        ...peerAccount,
        id: 'acc_private_tenant',
        organizationId: tenantOrganizationId,
        organizationName: 'Private Tenant',
      };
      const membership: PostgresBusinessRecord<Record<string, unknown>> = {
        organizationId: tenantOrganizationId,
        domain: 'park',
        resourceType: 'membership',
        resourceId: `membership_${tenantOrganizationId}`,
        ownerAccountId: null,
        status: 'active',
        version: 1,
        payload: {
          parkId: `park_${account.organizationId}`,
          adminOrganizationId: account.organizationId,
        },
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      };
      const targetLicense = targetLicenseModules
        ? {
            ...activeLicenseRecord({
              organizationId: tenantOrganizationId,
              modules: targetLicenseModules,
            }),
            organizationId: tenantOrganizationId,
          }
        : null;
      const repo = repository();
      repo.listParkTenantMemberships = vi.fn(async () => [membership]);
      repo.listAccounts = vi.fn(async (organizationId: string) =>
        organizationId === tenantOrganizationId
          ? [tenantAccount]
          : [account, peerAccount],
      );
      repo.getBusinessRecord = vi.fn(
        async (input: {
          organizationId: string;
          domain: string;
          resourceType: string;
          resourceId: string;
        }) => {
          if (
            input.domain !== 'commercial_control' ||
            input.resourceType !== 'license' ||
            input.resourceId !== 'current'
          ) {
            return null;
          }
          return input.organizationId === tenantOrganizationId
            ? targetLicense
            : activeLicenseRecord();
        },
      ) as unknown as typeof repo.getBusinessRecord;
      repo.getOrganizationFeatures = vi.fn(async (organizationId: string) => ({
        enterprise_tree:
          organizationId === tenantOrganizationId ? targetConfigured : true,
        direct_messages: true,
        atoa: true,
        park_services: true,
        knowledge: true,
        skill_market: true,
      }));
      const { baseUrl } = await listen(repo);

      const response = await fetch(
        `${baseUrl}/enterprise/organization/view?organizationId=${tenantOrganizationId}`,
        { headers: { authorization: 'Bearer clustered-session-token' } },
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toEqual({
        error: '企业树功能已由管理员关闭或未获授权',
        code: 'organization_feature_disabled',
        feature: 'enterprise_tree',
      });
      expect(body).not.toHaveProperty('license');
      expect(repo.getOrganization).not.toHaveBeenCalledWith(
        tenantOrganizationId,
      );
      expect(repo.listOrganizationStructure).not.toHaveBeenCalledWith(
        tenantOrganizationId,
      );
      expect(repo.listBusinessRecords).not.toHaveBeenCalled();
      expect(repo.getOrganizationFeatures).toHaveBeenCalledWith(
        account.organizationId,
      );
      expect(
        vi
          .mocked(repo.getOrganizationFeatures)
          .mock.calls.some(
            ([organizationId]) => organizationId === tenantOrganizationId,
          ),
      ).toBe(expectsTargetConfigurationRead);
    },
  );

  it('stores heartbeats in shared state and exposes presence in the organization tree', async () => {
    const touchAccountPresence = vi.fn(async () => ({
      accountId: account.id,
      online: true,
      lastSeenAt: '2026-08-01T00:00:00.000Z',
    }));
    const listAccountPresence = vi.fn(async () => [
      {
        accountId: account.id,
        online: true,
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
      { accountId: peerAccount.id, online: false, lastSeenAt: null },
    ]);
    const sharedState = {
      getAccountBySession: vi.fn(async () => account),
      touchAccountPresence,
      listAccountPresence,
    } as unknown as ClusteredEnterpriseSharedState;
    const { baseUrl } = await listen(
      repository(activeLicenseRecord({ modules: ['direct_messages'] })),
      { sharedState },
    );
    const authorization = 'Bearer clustered-session-token';

    const heartbeat = await fetch(`${baseUrl}/enterprise/presence/heartbeat`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ clientId: 'desktop-main' }),
    });
    expect(heartbeat.status).toBe(200);
    await expect(heartbeat.json()).resolves.toMatchObject({
      presence: { accountId: 'acc_admin', online: true },
    });
    expect(touchAccountPresence).toHaveBeenCalledWith({
      organizationId: 'org_default',
      accountId: 'acc_admin',
      clientId: 'desktop-main',
    });

    const organization = await fetch(
      `${baseUrl}/enterprise/organization/view`,
      { headers: { authorization } },
    );
    expect(organization.status).toBe(200);
    await expect(organization.json()).resolves.toMatchObject({
      members: [
        {
          id: 'acc_admin',
          ottoOnline: true,
          ottoLastSeenAt: '2026-08-01T00:00:00.000Z',
        },
        {
          id: 'acc_peer',
          ottoOnline: false,
          ottoLastSeenAt: null,
        },
      ],
    });
    expect(listAccountPresence).toHaveBeenCalledWith('org_default', [
      'acc_admin',
      'acc_peer',
    ]);
  });

  it('keeps same-organization directory, feature discovery, presence, and chat in the licensed baseline', async () => {
    const repo = repository(activeLicenseRecord({ modules: [] }));
    repo.getOrganizationInvite = vi.fn(async () => ({
      id: 'orginvite_baseline',
      organizationId: 'org_default',
      code: 'Ab3D-k9Pq-Z7xY',
      status: 'active' as const,
      defaultDepartment: null,
      departmentId: null,
      positionId: null,
      positionTitle: null,
      defaultRole: null,
      maxUses: null,
      usedCount: 0,
      issuedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-08T00:00:00.000Z',
      validHours: 168 as const,
    }));
    const sharedState = {
      getAccountBySession: vi.fn(async () => account),
      touchAccountPresence: vi.fn(async () => ({
        accountId: account.id,
        online: true,
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      })),
      listAccountPresence: vi.fn(async () => []),
    } as unknown as ClusteredEnterpriseSharedState;
    const { baseUrl } = await listen(repo, { sharedState });
    const headers = { authorization: 'Bearer clustered-session-token' };

    for (const [path, request] of [
      [
        '/enterprise/organization/view',
        fetch(`${baseUrl}/enterprise/organization/view`, { headers }),
      ],
      [
        '/enterprise/organization/features',
        fetch(`${baseUrl}/enterprise/organization/features`, { headers }),
      ],
      [
        '/enterprise/accounts',
        fetch(`${baseUrl}/enterprise/accounts`, { headers }),
      ],
      [
        '/enterprise/organization/invite',
        fetch(`${baseUrl}/enterprise/organization/invite`, { headers }),
      ],
      [
        '/enterprise/messages/unread',
        fetch(`${baseUrl}/enterprise/messages/unread`, { headers }),
      ],
      [
        '/enterprise/presence/heartbeat',
        fetch(`${baseUrl}/enterprise/presence/heartbeat`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ clientId: 'desktop-main' }),
        }),
      ],
    ] as const) {
      const response = await request;
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(
        200,
      );
    }

    const featureStateResponse = await fetch(
      `${baseUrl}/enterprise/organization/features`,
      { headers },
    );
    await expect(featureStateResponse.json()).resolves.toMatchObject({
      configured: {
        enterprise_tree: true,
        park_service: true,
        direct_messages: true,
      },
      entitled: {
        enterprise_tree: false,
        park_service: false,
        direct_messages: false,
      },
      effective: {
        enterprise_tree: false,
        park_service: false,
        direct_messages: false,
      },
      features: {
        enterprise_tree: false,
        park_service: false,
        direct_messages: false,
      },
    });

    repo.getOrganizationFeatures = vi.fn(async () => ({
      enterprise_tree: true,
      direct_messages: false,
      atoa: true,
      park_services: true,
      knowledge: true,
      skill_market: true,
    }));
    const disabledMessages = await fetch(
      `${baseUrl}/enterprise/messages/unread`,
      { headers },
    );
    expect(disabledMessages.status).toBe(403);
    await expect(disabledMessages.json()).resolves.toMatchObject({
      code: 'organization_feature_disabled',
      feature: 'direct_messages',
    });
  });

  it('serves complete versioned legal text and records exact document consent', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const legal = await fetch(`${baseUrl}/enterprise/legal`, {
      headers: { accept: 'text/html' },
    });
    expect(legal.status).toBe(200);
    const html = await legal.text();
    expect(html).toContain('正文 SHA-256');
    expect(html).toContain(CURRENT_LEGAL_DOCUMENTS[0]!.sections[0]!.title);

    const privacy = await fetch(`${baseUrl}/enterprise/privacy`, {
      headers: { authorization: 'Bearer clustered-session-token' },
    });
    expect(privacy.status).toBe(200);
    expect(await privacy.json()).toMatchObject({
      currentConsentComplete: false,
      authorization: {
        license: { status: 'active', enforce: true },
        dataBoundary: { authority: 'postgresql' },
      },
    });

    const stale = await fetch(`${baseUrl}/enterprise/privacy/accept`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accepted: true, documents: [] }),
    });
    expect(stale.status).toBe(409);

    const references = currentLegalDocumentReferences();
    const accepted = await fetch(`${baseUrl}/enterprise/privacy/accept`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accepted: true, documents: references }),
    });
    expect(accepted.status).toBe(200);
    expect(repo.recordCurrentLegalConsent).toHaveBeenCalledWith(
      account,
      references,
    );
  });

  it('relays MLS KeyPackages and opaque events through the PostgreSQL authority', async () => {
    const keyPackage = {
      reference: 'a'.repeat(64),
      accountId: 'acc_peer',
      deviceId: 'peer-device',
      ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
      keyPackage: Buffer.from('key-package').toString('base64'),
      createdAt: '2026-08-01T00:00:00.000Z',
      claimedAt: null,
    };
    const publishMlsKeyPackage = vi.fn(async () => keyPackage);
    const listMlsKeyPackageInventory = vi.fn(async () => [
      {
        reference: keyPackage.reference,
        expiresAt: '2026-08-08T00:00:00.000Z',
      },
    ]);
    const retireMlsKeyPackage = vi.fn(async () => true);
    const claimMlsKeyPackage = vi.fn(async () => keyPackage);
    const appendMlsTransportEvent = vi.fn(async () => ({
      sequence: 1,
      eventId: 'commit-1',
      conversationId: 'b'.repeat(64),
      senderAccountId: 'acc_admin',
      senderDeviceId: 'admin-device',
      recipientAccountId: null,
      recipientDeviceId: null,
      eventType: 'commit',
      epoch: 1,
      groupId: Buffer.from('group').toString('base64'),
      payload: Buffer.from('commit').toString('base64'),
      keyPackageReference: null,
      createdAt: '2026-08-01T00:00:01.000Z',
    }));
    const listMlsTransportEvents = vi.fn(async () => []);
    const listMlsInboundConversationPeers = vi.fn(async () => ['acc_peer']);
    const repo = {
      ...repository(),
      publishMlsKeyPackage,
      listMlsKeyPackageInventory,
      retireMlsKeyPackage,
      claimMlsKeyPackage,
      appendMlsTransportEvent,
      listMlsTransportEvents,
      listMlsInboundConversationPeers,
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo);
    const headers = {
      authorization: 'Bearer clustered-session-token',
      'content-type': 'application/json',
    };

    const publish = await fetch(`${baseUrl}/enterprise/e2ee/mls/key-packages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deviceId: 'admin-device',
        ciphersuite: keyPackage.ciphersuite,
        keyPackageReference: keyPackage.reference,
        keyPackage: keyPackage.keyPackage,
      }),
    });
    expect(publish.status).toBe(201);
    const inventory = await fetch(
      `${baseUrl}/enterprise/e2ee/mls/key-packages/inventory?deviceId=admin-device`,
      { headers },
    );
    expect(inventory.status).toBe(200);
    expect(inventory.headers.get('cache-control')).toBe('no-store');
    await expect(inventory.json()).resolves.toEqual({
      deviceId: 'admin-device',
      keyPackages: [
        {
          reference: keyPackage.reference,
          expiresAt: '2026-08-08T00:00:00.000Z',
        },
      ],
    });
    const retired = await fetch(
      `${baseUrl}/enterprise/e2ee/mls/key-packages/${keyPackage.reference}?deviceId=admin-device`,
      { method: 'DELETE', headers },
    );
    expect(retired.status).toBe(200);
    await expect(retired.json()).resolves.toEqual({
      deviceId: 'admin-device',
      reference: keyPackage.reference,
      retired: true,
    });
    const claim = await fetch(
      `${baseUrl}/enterprise/e2ee/mls/key-packages/claim`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          requesterDeviceId: 'admin-device',
          recipientAccountId: 'acc_peer',
        }),
      },
    );
    expect(claim.status).toBe(200);
    const inbound = await fetch(
      `${baseUrl}/enterprise/e2ee/mls/inbound-conversations?deviceId=admin-device&afterPeerAccountId=acc_aaron&limit=25`,
      { headers },
    );
    expect(inbound.status).toBe(200);
    expect(inbound.headers.get('cache-control')).toBe('no-store');
    await expect(inbound.json()).resolves.toEqual({
      peerAccountIds: ['acc_peer'],
    });
    const eventsUrl = `${baseUrl}/enterprise/e2ee/mls/conversations/acc_peer/events`;
    const appended = await fetch(eventsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        senderDeviceId: 'admin-device',
        eventId: 'commit-1',
        eventType: 'commit',
        epoch: 1,
        groupId: Buffer.from('group').toString('base64'),
        payload: Buffer.from('commit').toString('base64'),
      }),
    });
    expect(appended.status).toBe(201);
    const listed = await fetch(eventsUrl, { headers });
    expect(listed.status).toBe(200);

    expect(publishMlsKeyPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        accountId: 'acc_admin',
        deviceId: 'admin-device',
        reference: keyPackage.reference,
      }),
    );
    expect(listMlsKeyPackageInventory).toHaveBeenCalledWith({
      organizationId: 'org_default',
      accountId: 'acc_admin',
      deviceId: 'admin-device',
    });
    expect(retireMlsKeyPackage).toHaveBeenCalledWith({
      organizationId: 'org_default',
      accountId: 'acc_admin',
      deviceId: 'admin-device',
      reference: keyPackage.reference,
    });
    expect(claimMlsKeyPackage).toHaveBeenCalledWith(
      expect.objectContaining({ recipientAccountId: 'acc_peer' }),
    );
    expect(appendMlsTransportEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'commit', epoch: 1 }),
    );
    expect(listMlsTransportEvents).toHaveBeenCalled();
    expect(listMlsInboundConversationPeers).toHaveBeenCalledWith({
      organizationId: 'org_default',
      accountId: 'acc_admin',
      deviceId: 'admin-device',
      afterPeerAccountId: 'acc_aaron',
      limit: 25,
    });

    const health = (await (
      await fetch(`${baseUrl}/enterprise/health`)
    ).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain('e2ee_mls_transport_v1');
    expect(health.capabilities).toContain('e2ee_mls_resource_governance_v1');
    expect(health.capabilities).toContain(
      'e2ee_mls_transport_session_reset_v1',
    );
    expect(health.capabilities).not.toContain('e2ee_mls_v1');
  });

  it('enforces a PostgreSQL-shared login block before checking credentials', async () => {
    const repo = repository();
    vi.mocked(repo.getLoginRetryAfter).mockResolvedValue(45);
    const { baseUrl } = await listen(repo);

    const response = await fetch(`${baseUrl}/enterprise/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin', password: 'guess' }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('45');
    expect(await response.json()).toMatchObject({
      code: 'LOGIN_RATE_LIMITED',
      retryAfterSeconds: 45,
    });
    expect(repo.authenticateAccount).not.toHaveBeenCalled();
  });

  it('serves account sync from the PostgreSQL tenant authority', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const response = await fetch(`${baseUrl}/enterprise/account-sync`, {
      method: 'PUT',
      headers: { authorization: 'Bearer clustered-session-token' },
      body: JSON.stringify({
        scope: 'worklog',
        expectedVersion: 0,
        deviceId: 'desktop-1',
        payload: {
          schemaVersion: 1,
          generatedAt: '2026-08-01T00:00:00.000Z',
          files: [],
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      snapshot: { scope: 'worklog', version: 1, deviceId: 'desktop-1' },
    });
    expect(repo.putAccountSyncSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        accountId: 'acc_admin',
        expectedVersion: 0,
      }),
    );
  });

  it('allows sync export but blocks sync writes when the License is inactive', async () => {
    const repo = repository(null);
    const { baseUrl } = await listen(repo);
    const headers = { authorization: 'Bearer clustered-session-token' };
    const restored = await fetch(`${baseUrl}/enterprise/account-sync`, {
      headers,
    });
    expect(restored.status).toBe(200);
    const stored = await fetch(`${baseUrl}/enterprise/account-sync`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'worklog',
        expectedVersion: 0,
        payload: {
          schemaVersion: 1,
          generatedAt: '2026-08-14T00:00:00Z',
          files: [],
        },
      }),
    });
    expect(stored.status).toBe(402);
    expect(repo.putAccountSyncSnapshot).not.toHaveBeenCalled();
  });

  it('allows an over-seat administrator to disable an account for remediation', async () => {
    const repo = {
      ...repository(activeLicenseRecord({ seatLimit: 1 })),
      getAccount: vi.fn(async () => peerAccount),
      updateAccount: vi.fn(async () => ({
        ...peerAccount,
        status: 'disabled' as const,
      })),
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo);
    const response = await fetch(
      `${baseUrl}/enterprise/accounts/${peerAccount.id}`,
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer clustered-session-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'disabled' }),
      },
    );
    expect(response.status).toBe(200);
    expect(repo.updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'disabled' }),
    );
  });

  it('stores knowledge and skills under the authenticated PostgreSQL tenant', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const headers = {
      authorization: 'Bearer clustered-session-token',
      'content-type': 'application/json',
    };
    const knowledge = await fetch(`${baseUrl}/enterprise/knowledge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        category: 'runbook',
        content: 'Restore from PITR.',
      }),
    });
    expect(knowledge.status).toBe(200);
    await expect(knowledge.json()).resolves.toMatchObject({
      added: true,
      reviewStatus: 'active',
    });

    const skill = await fetch(`${baseUrl}/enterprise/skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Incident triage',
        description: 'Classifies and routes incidents.',
        content: '# Incident triage\n\nFollow the verified runbook.',
        visibility: 'company',
      }),
    });
    expect(skill.status).toBe(201);
    await expect(skill.json()).resolves.toMatchObject({
      outcome: 'submitted',
      skill: { name: 'Incident triage', status: 'active' },
    });
    expect(repo.createBusinessRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        domain: 'skills',
        ownerAccountId: 'acc_admin',
      }),
    );
  });

  it('hides expired clustered knowledge and restores it through audited revalidation', async () => {
    let knowledgeRecord: PostgresBusinessRecord<Record<string, unknown>> = {
      organizationId: account.organizationId,
      domain: 'knowledge',
      resourceType: 'entry',
      resourceId: 'knowledge-expired',
      ownerAccountId: account.id,
      status: 'active',
      version: 2,
      payload: {
        title: 'Expired runbook',
        department: null,
        category: 'runbook',
        content: 'Restore from the verified backup.',
        tags: [],
        contributor: account.name,
        contributorAccountId: account.id,
        confidence: 0.9,
        sourceType: 'manual',
        sourceId: null,
        sourceLabel: null,
        reviewedBy: account.name,
        reviewedAt: '2025-01-01T00:00:00.000Z',
        reviewNote: null,
        reviewDueAt: '2025-06-30T00:00:00.000Z',
        expiresAt: '2025-12-31T00:00:00.000Z',
      },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const baseRepo = repository();
    const repo = {
      ...baseRepo,
      listBusinessRecords: vi.fn(async () => [knowledgeRecord]),
      getBusinessRecord: vi.fn(
        async (input: {
          domain: string;
          resourceType: string;
          resourceId: string;
        }) => {
          if (
            input.domain === 'commercial_control' &&
            input.resourceId === 'current'
          ) {
            return activeLicenseRecord();
          }
          if (
            input.domain === 'knowledge' &&
            input.resourceId === knowledgeRecord.resourceId
          ) {
            return knowledgeRecord;
          }
          return null;
        },
      ),
      updateBusinessRecord: vi.fn(
        async (input: {
          expectedVersion: number;
          status: string;
          payload: Record<string, unknown>;
        }) => {
          if (input.expectedVersion !== knowledgeRecord.version) return null;
          knowledgeRecord = {
            ...knowledgeRecord,
            status: input.status,
            version: knowledgeRecord.version + 1,
            payload: input.payload,
            updatedAt: new Date().toISOString(),
          };
          return knowledgeRecord;
        },
      ),
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo);

    const memberList = await fetch(`${baseUrl}/enterprise/knowledge`, {
      headers: { authorization: 'Bearer peer-session-token' },
    });
    expect(memberList.status).toBe(200);
    await expect(memberList.json()).resolves.toEqual({ knowledge: [] });

    const adminReviewList = await fetch(
      `${baseUrl}/enterprise/knowledge?includeReview=true`,
      { headers: { authorization: 'Bearer clustered-session-token' } },
    );
    expect(adminReviewList.status).toBe(200);
    await expect(adminReviewList.json()).resolves.toMatchObject({
      knowledge: [
        { id: 'knowledge-expired', expiresAt: '2025-12-31T00:00:00.000Z' },
      ],
    });

    const revalidation = await fetch(
      `${baseUrl}/enterprise/knowledge/knowledge-expired/revalidate`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer clustered-session-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          rationale: '已核对当前备份制度和最近恢复演练，确认该知识继续有效。',
          validForDays: 180,
        }),
      },
    );
    expect(revalidation.status).toBe(200);
    const revalidatedPayload = (await revalidation.json()) as {
      knowledge: { reviewDueAt: string; expiresAt: string };
    };
    expect(
      Date.parse(revalidatedPayload.knowledge.reviewDueAt),
    ).toBeGreaterThan(Date.now());
    expect(Date.parse(revalidatedPayload.knowledge.expiresAt)).toBeGreaterThan(
      Date.parse(revalidatedPayload.knowledge.reviewDueAt),
    );
    expect(repo.appendBusinessEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: account.organizationId,
        eventType: 'revalidated',
        payload: expect.objectContaining({ validForDays: 180 }),
      }),
    );

    const restoredList = await fetch(`${baseUrl}/enterprise/knowledge`, {
      headers: { authorization: 'Bearer peer-session-token' },
    });
    await expect(restoredList.json()).resolves.toMatchObject({
      knowledge: [{ id: 'knowledge-expired' }],
    });
  });

  it('keeps the administrator evidence endpoint compatible until clustered evidence is retained', async () => {
    const repo = {
      ...repository(),
      getBusinessRecord: vi.fn(
        async (input: {
          domain: string;
          resourceType: string;
          resourceId: string;
        }) => {
          if (
            input.domain === 'commercial_control' &&
            input.resourceId === 'current'
          ) {
            return activeLicenseRecord();
          }
          if (
            input.domain === 'knowledge' &&
            input.resourceId === 'knowledge-1'
          ) {
            return {
              organizationId: account.organizationId,
              domain: 'knowledge',
              resourceType: 'entry',
              resourceId: 'knowledge-1',
              ownerAccountId: account.id,
              status: 'active',
              version: 1,
              payload: {
                title: 'Runbook',
                department: null,
                category: 'runbook',
                content: 'Restore from PITR.',
                tags: [],
                contributor: account.name,
                contributorAccountId: account.id,
                confidence: 0.9,
                sourceType: 'manual',
                sourceId: null,
                sourceLabel: null,
                reviewedBy: account.name,
                reviewedAt: '2026-08-01T00:00:00.000Z',
                reviewNote: null,
              },
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
            };
          }
          return null;
        },
      ),
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo);

    const evidence = await fetch(
      `${baseUrl}/enterprise/knowledge/knowledge-1/evidence`,
      { headers: { authorization: 'Bearer clustered-session-token' } },
    );
    expect(evidence.status).toBe(200);
    await expect(evidence.json()).resolves.toEqual({ evidence: [] });

    const memberEvidence = await fetch(
      `${baseUrl}/enterprise/knowledge/knowledge-1/evidence`,
      { headers: { authorization: 'Bearer peer-session-token' } },
    );
    expect(memberEvidence.status).toBe(403);
  });

  it('accepts the desktop feature PATCH contract for migrated domains', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const response = await fetch(
      `${baseUrl}/enterprise/organization/features`,
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer clustered-session-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          park_service: false,
          knowledge: false,
          skill_market: false,
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      configured: {
        park_service: false,
        knowledge: false,
        skill_market: false,
      },
      entitled: {
        park_service: true,
        knowledge: true,
        skill_market: true,
        feishu_auto_reply: false,
      },
      effective: {
        park_service: false,
        knowledge: false,
        skill_market: false,
        feishu_auto_reply: false,
      },
      features: {
        park_service: false,
        knowledge: false,
        skill_market: false,
        feishu_auto_reply: false,
      },
    });
    expect(repo.updateOrganizationFeatures).toHaveBeenCalledWith(
      'org_default',
      { park_services: false, knowledge: false, skill_market: false },
    );
  });

  it('rejects unsupported or empty clustered feature patches without persisting them', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const headers = {
      authorization: 'Bearer clustered-session-token',
      'content-type': 'application/json',
    };

    for (const [body, code] of [
      [{ feishu_auto_reply: true }, 'organization_feature_not_supported'],
      [{}, 'organization_feature_patch_empty'],
    ] as const) {
      const response = await fetch(
        `${baseUrl}/enterprise/organization/features`,
        { method: 'PATCH', headers, body: JSON.stringify(body) },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code });
    }

    expect(repo.updateOrganizationFeatures).not.toHaveBeenCalled();
  });

  it('mounts park, ticketing and commercial control on PostgreSQL authority', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const headers = {
      authorization: 'Bearer clustered-session-token',
      'content-type': 'application/json',
    };

    const park = await fetch(`${baseUrl}/enterprise/park`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Otto Campus' }),
    });
    expect(park.status).toBe(200);
    await expect(park.json()).resolves.toMatchObject({
      park: { name: 'Otto Campus' },
    });

    const ticket = await fetch(`${baseUrl}/enterprise/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serviceId: 'it',
        title: 'PostgreSQL cutover check',
        description: 'Verify the authoritative route.',
      }),
    });
    expect(ticket.status).toBe(201);
    await expect(ticket.json()).resolves.toMatchObject({
      ticket: { title: 'PostgreSQL cutover check', status: 'open' },
    });

    const deployment = await fetch(`${baseUrl}/enterprise/deployment/status`, {
      headers,
    });
    expect(deployment.status).toBe(200);
    await expect(deployment.json()).resolves.toMatchObject({
      authority: 'postgresql',
      dataBoundary: {
        messageContent: 'client_e2ee_ciphertext_only',
        clientIdentityPrivateKeys: 'client_only',
      },
    });
    expect(repo.createBusinessRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        domain: 'ticketing',
      }),
    );
  });

  it('preserves member update-policy and module-manifest contracts', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const authorization = 'Bearer peer-session-token';
    const policy = await fetch(
      `${baseUrl}/enterprise/deployment/update-policy`,
      {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          distributionId: 'desktop-win32-x64',
          currentVersion: '1.10.0',
        }),
      },
    );
    expect(policy.status).toBe(200);
    await expect(policy.json()).resolves.toEqual({
      status: 'not_configured',
      reason: 'online_license_required',
    });

    const manifest = await fetch(
      `${baseUrl}/enterprise/modules/updates/client`,
      { headers: { authorization } },
    );
    expect(manifest.status).toBe(200);
    await expect(manifest.json()).resolves.toMatchObject({
      format: 'otto-module-updates-v1',
      deploymentId: 'clustered-enterprise',
      modules: [],
    });
  });

  it('exports and deletes account data through the PostgreSQL repository', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const authorization = 'Bearer clustered-session-token';
    const exported = await fetch(`${baseUrl}/enterprise/privacy/export`, {
      headers: { authorization },
    });
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toMatchObject({
      format: 'otto-account-export-v1',
      account: { id: 'acc_admin', organizationId: 'org_default' },
    });

    const deleted = await fetch(`${baseUrl}/enterprise/privacy/account`, {
      method: 'DELETE',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        password: 'correct-password',
        confirmation: '注销我的 Otto 账号',
      }),
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      accountId: 'acc_admin',
      mode: 'cryptographic_and_soft_delete',
    });
    expect(repo.deleteOwnAccountData).toHaveBeenCalledWith(account);
  });

  it('issues organization invites through PostgreSQL without exposing a stored code', async () => {
    const issueOrganizationInvite = vi.fn(async () => ({
      id: 'orginvite_1',
      organizationId: 'org_default',
      code: 'ABCD-EFGH-JKLM',
      status: 'active' as const,
      defaultDepartment: null,
      departmentId: null,
      positionId: null,
      positionTitle: null,
      defaultRole: null,
      maxUses: 3,
      usedCount: 0,
      issuedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-08T00:00:00.000Z',
      validHours: 168 as const,
    }));
    const repo = {
      ...repository(activeLicenseRecord({ modules: [] })),
      issueOrganizationInvite,
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo, {
      publicUrl: 'https://join.otto.example',
    });

    const response = await fetch(`${baseUrl}/enterprise/organization/invite`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ maxUses: 3 }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      invite: {
        code: 'ABCD-EFGH-JKLM',
        link: 'https://join.otto.example/enterprise/join/ABCD-EFGH-JKLM',
      },
    });
    expect(issueOrganizationInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        createdByAccountId: 'acc_admin',
        maxUses: 3,
      }),
    );
  });

  it('serves active public invitation pages from PostgreSQL inspection state', async () => {
    const repo = {
      ...repository(),
      inspectOrganizationInvite: vi.fn(async () => ({
        status: 'active' as const,
        organizationId: 'org_default',
      })),
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo, {
      publicUrl: 'https://join.otto.example',
    });

    const response = await fetch(`${baseUrl}/enterprise/join/ABCD-EFGH-JKLM`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('ABCD-EFGH-JKLM');
  });

  it('requests and completes SMS registration through PostgreSQL state', async () => {
    const requestSmsRegistration = vi.fn(async () => ({
      state: 'issued' as const,
      challengeId: 'smsreg_1',
      expiresAt: '2026-08-01T00:05:00.000Z',
      retryAfterSeconds: 60,
      registrationMode: 'personal' as const,
      organization: null,
    }));
    const completeSmsRegistration = vi.fn(async () => ({
      state: 'registered' as const,
      account: { ...account, id: 'acc_new', accountType: 'personal' as const },
    }));
    const repo = {
      ...repository(),
      requestSmsRegistration,
      discardSmsRegistrationChallenge: vi.fn(async () => undefined),
      inspectSmsRegistrationChallenge: vi.fn(async () => ({
        organizationId: 'org_default',
        registrationMode: 'personal' as const,
      })),
      completeSmsRegistration,
    } as unknown as PostgresEnterpriseCoreRepository;
    const smsSender = {
      sendVerificationCode: vi.fn(async () => true),
    };
    const { baseUrl } = await listen(repo, { smsSender });

    const request = await fetch(
      `${baseUrl}/enterprise/auth/register/sms/request`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '13800138000' }),
      },
    );
    expect(request.status).toBe(200);
    expect(await request.json()).toMatchObject({
      challengeId: 'smsreg_1',
      registrationMode: 'personal',
    });
    expect(smsSender.sendVerificationCode).toHaveBeenCalledWith(
      '13800138000',
      expect.stringMatching(/^\d{6}$/),
    );

    const verify = await fetch(
      `${baseUrl}/enterprise/auth/register/sms/verify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'smsreg_1',
          code: '123456',
          name: 'New User',
          password: 'Secure-password-2026',
          legalConsent: true,
          legalDocuments: currentLegalDocumentReferences(),
        }),
      },
    );
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({
      account: { id: 'acc_new', accountType: 'personal' },
      token: 'clustered-session-token',
      legalConsentRecorded: true,
    });
    expect(completeSmsRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: 'smsreg_1',
        code: '123456',
        legalConsent: true,
        legalDocuments: currentLegalDocumentReferences(),
      }),
    );
  });

  it('joins a personal account to an enterprise and expires stale sessions', async () => {
    const personal = {
      ...account,
      id: 'acc_personal',
      organizationId: 'org_personal',
      organizationName: 'Personal',
      accountType: 'personal' as const,
      isAdmin: false,
    };
    const joined = {
      ...personal,
      organizationId: 'org_default',
      organizationName: 'Otto',
      accountType: 'enterprise' as const,
    };
    const joinOrganizationWithInvite = vi.fn(async () => ({
      state: 'joined' as const,
      account: joined,
    }));
    const repo = {
      ...repository(activeLicenseRecord({ modules: [] })),
      getAccountBySession: vi.fn(async () => personal),
      inspectOrganizationInvite: vi.fn(async () => ({
        status: 'active' as const,
        organizationId: 'org_default',
      })),
      joinOrganizationWithInvite,
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo);

    const response = await fetch(
      `${baseUrl}/enterprise/auth/join-organization`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer personal-session',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ inviteCode: 'ABCD-EFGH-JKLM' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      account: { id: 'acc_personal', organizationId: 'org_default' },
      requiresLogin: true,
    });
    expect(joinOrganizationWithInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc_personal',
        inviteCode: 'ABCD-EFGH-JKLM',
      }),
    );
  });

  it('does not authorize an empty configured system token', async () => {
    const repo = repository();
    const created = createClusteredEnterpriseServer(repo, {
      host: '127.0.0.1',
      port: 0,
      adminToken: '',
    });
    servers.push(created.server);
    await new Promise<void>((resolve) =>
      created.server.listen(0, '127.0.0.1', resolve),
    );
    const address = created.server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/enterprise/accounts`,
      { headers: { 'x-otto-admin-token': '' } },
    );
    expect(response.status).toBe(401);
  });

  it('stores only E2EE ciphertext through the shared attachment service', async () => {
    const putInlineCiphertext = vi.fn(async () => ({
      id: 'att_01',
      state: 'available',
      ciphertextBytes: 32,
      ciphertextSha256: 'b'.repeat(64),
      encryption: 'e2ee-client-v1',
      expiresAt: '2026-08-01T01:00:00.000Z',
      location: { backend: 's3', key: 'attachments/v1/opaque.bin' },
    }));
    const attachmentStorage = {
      putInlineCiphertext,
    } as unknown as NonNullable<
      Parameters<typeof createClusteredEnterpriseServer>[1]
    >['attachmentStorage'];
    const { baseUrl } = await listen(repository(), { attachmentStorage });
    const ciphertext = Buffer.alloc(32, 7);

    const response = await fetch(`${baseUrl}/enterprise/attachments/inline`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        peerAccountId: 'acc_peer',
        attachmentId: 'att_01',
        ciphertext: ciphertext.toString('base64'),
        ciphertextSha256: 'b'.repeat(64),
      }),
    });

    expect(response.status).toBe(201);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      attachment: {
        id: 'att_01',
        state: 'available',
        ciphertextBytes: 32,
        ciphertextSha256: 'b'.repeat(64),
        encryption: 'e2ee-client-v1',
        expiresAt: '2026-08-01T01:00:00.000Z',
      },
    });
    expect(JSON.stringify(responseBody)).not.toContain('opaque.bin');
    expect(putInlineCiphertext).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        accountId: 'acc_admin',
        attachmentId: 'att_01',
        encryption: 'e2ee-client-v1',
        authorizedAccountIds: ['acc_peer'],
        ciphertext,
      }),
    );
  });

  it('atomically binds an MLS upload to the authoritative generation and device roster', async () => {
    const session = {
      conversationId: 'a'.repeat(64),
      sessionGeneration: 2,
      groupId: 'Z3JvdXAtMQ==',
      epoch: 4,
      participantAccountIds: ['acc_admin', 'acc_peer'] as [string, string],
      authorizedDevices: [
        { accountId: 'acc_admin', deviceId: 'device-admin' },
        { accountId: 'acc_peer', deviceId: 'device-peer' },
      ],
    };
    const getMlsAttachmentSession = vi.fn(async () => session);
    const repo = {
      ...repository(),
      getMlsAttachmentSession,
    } as PostgresEnterpriseCoreRepository;
    const initiateMultipartUpload = vi.fn(async () => ({
      attachmentId: 'mls-att-1',
      key: 'opaque',
      uploadId: 'upload-1',
    }));
    const attachmentStorage = {
      initiateMultipartUpload,
    } as unknown as NonNullable<
      Parameters<typeof createClusteredEnterpriseServer>[1]
    >['attachmentStorage'];
    const { baseUrl } = await listen(repo, { attachmentStorage });

    const response = await fetch(`${baseUrl}/enterprise/attachments/uploads`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        peerAccountId: 'acc_peer',
        deviceId: 'device-admin',
        attachmentId: 'mls-att-1',
        ciphertextBytes: 80,
        ciphertextSha256: 'b'.repeat(64),
        mlsBinding: {
          organizationId: 'org_default',
          conversationId: session.conversationId,
          sessionGeneration: 2,
          groupId: session.groupId,
          epoch: 4,
          messageId: 'mls-message-1',
        },
        authorizedDevices: session.authorizedDevices,
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      upload: { attachmentId: 'mls-att-1' },
    });
    expect(getMlsAttachmentSession).toHaveBeenCalledWith({
      organizationId: 'org_default',
      accountId: 'acc_admin',
      peerAccountId: 'acc_peer',
      deviceId: 'device-admin',
    });
    expect(initiateMultipartUpload).toHaveBeenCalledWith({
      organizationId: 'org_default',
      accountId: 'acc_admin',
      attachmentId: 'mls-att-1',
      ciphertextBytes: 80,
      ciphertextSha256: 'b'.repeat(64),
      encryption: 'mls-client-v1',
      authorizedAccountIds: ['acc_peer'],
      mlsAuthorization: {
        ...session,
        messageId: 'mls-message-1',
      },
    });
    expect(JSON.stringify(initiateMultipartUpload.mock.calls)).not.toContain(
      'fileName',
    );
    expect(JSON.stringify(initiateMultipartUpload.mock.calls)).not.toContain(
      'dek',
    );
  });
});
