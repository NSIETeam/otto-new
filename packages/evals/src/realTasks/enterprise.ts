/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { canonicalJson } from '../../../server/src/modules/commercial_control/signedEnvelope.js';
import { EvidenceJournal, type Observation } from './evidence.js';

/** One fixture per dedicated process. Database/auth/routes are the real product. */
export async function startEnterpriseFixture(directory: string) {
  await mkdir(directory);
  const keys = generateKeyPairSync('ed25519');
  const adminToken = randomUUID();
  const settings = {
    OTTO_ENTERPRISE_DIR: directory,
    OTTO_ENTERPRISE_ADMIN_TOKEN: adminToken,
    OTTO_ENTERPRISE_PUBLIC_URL: 'http://127.0.0.1',
    OTTO_LICENSE_ENFORCE: 'true',
    OTTO_LICENSE_PUBLIC_KEY: keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    OTTO_LICENSE_PUBLIC_KEYS: '',
    OTTO_LICENSE_REVOKED_KEY_IDS: '',
    OTTO_ENTERPRISE_DEPLOYMENT_GRANTS:
      'enterprise_tree,park_service,direct_messages,knowledge',
    OTTO_TELEMETRY_ENDPOINT: '',
    OTTO_ENTERPRISE_FEISHU_APP_ID: '',
    OTTO_ENTERPRISE_FEISHU_APP_SECRET: '',
  };
  const previous = Object.fromEntries(
    Object.keys(settings).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, settings);
  const { createEnterpriseServer } =
    await import('../../../server/src/enterprise/server.js');
  const db = await import('../../../server/src/enterprise/db.js');
  const { server } = createEnterpriseServer({
    host: '127.0.0.1',
    adminToken,
    publicUrl: 'http://127.0.0.1',
    smsSender: null,
    repairSmsSender: null,
    repairFeishuSender: null,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No local enterprise port');
  const base = `http://127.0.0.1:${address.port}`;
  const requests: Array<{
    actor: string;
    method: string;
    route: string;
    status: number;
    data: unknown;
  }> = [];
  const actors = new Map<
    string,
    { token: string; account: ReturnType<typeof db.createAccount> }
  >();
  const api = async (
    actor: string,
    method: string,
    route: string,
    body?: unknown,
  ) => {
    if (
      !/^\/enterprise\/[a-z\d_/?=&.-]+$/iu.test(route) ||
      route.includes('..')
    )
      throw new Error('Invalid local test route');
    const headers: Record<string, string> =
      actor === 'system'
        ? { 'x-otto-admin-token': adminToken }
        : {
            authorization: `Bearer ${actors.get(actor)?.token ?? 'not-authenticated'}`,
          };
    const response = await fetch(base + route, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    // Never record the Authorization header, passwords or session token.
    requests.push({ actor, method, route, status: response.status, data });
    return { status: response.status, data };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.closeEnterpriseDatabase();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const { data: deployment } = await api(
      'system',
      'GET',
      '/enterprise/deployment/status',
    );
    const license = {
      id: 'lic_isolated_evaluation',
      deploymentId: deployment.deploymentId,
      organizationId: 'org_default',
      machineFingerprint: deployment.machineFingerprint,
      customerName: 'Isolated evaluation ONLY',
      plan: 'enterprise',
      expiresAtMs: Date.now() + 3600000,
      seatLimit: 30,
      modules: [
        'enterprise_tree',
        'park_service',
        'direct_messages',
        'knowledge',
      ],
      offline: true,
      telemetryAllowed: false,
      telemetryToken: 'isolated-evaluation-no-telemetry-00000000',
      issuedAtMs: Date.now(),
    };
    const imported = await api(
      'system',
      'POST',
      '/enterprise/deployment/license',
      {
        license,
        signature: `ed25519:${sign(null, Buffer.from(canonicalJson(license)), keys.privateKey).toString('base64url')}`,
      },
    );
    if (imported.status !== 200)
      throw new Error(
        `Isolated license admission failed: ${JSON.stringify(imported.data)}`,
      );
    const a = db.createOrganization({
      name: 'Eval Tenant A',
      slug: `eval-a-${randomUUID()}`,
    });
    const b = db.createOrganization({
      name: 'Eval Tenant B',
      slug: `eval-b-${randomUUID()}`,
    });
    const parkOrg = db.createOrganization({
      name: 'Eval Park',
      slug: `eval-park-${randomUUID()}`,
    });
    for (const [name, organization, isAdmin] of [
      ['a-admin', a, true],
      ['a-member', a, false],
      ['b-admin', b, true],
      ['b-member', b, false],
      ['park-admin', parkOrg, true],
      ['staff-one', parkOrg, false],
      ['staff-two', parkOrg, false],
    ] as const) {
      const account = db.createAccount({
        organizationId: organization.id,
        username: `${name}-${randomUUID()}`,
        name,
        password: randomUUID() + '!A2',
        isAdmin,
      });
      actors.set(name, {
        account,
        token: db.createAuthSession(account.id).token,
      });
    }
    const parkAdmin = actors.get('park-admin')!.account;
    const park = db.createPark({
      adminOrganizationId: parkOrg.id,
      actorAccountId: parkAdmin.id,
      name: 'Evaluation Park',
    });
    for (const name of ['a-admin', 'b-admin']) {
      const account = actors.get(name)!.account;
      const invite = db.issueParkInvite({
        parkId: park.id,
        actorAccountId: parkAdmin.id,
      });
      db.joinOrganizationToPark({
        organizationId: account.organizationId,
        actorAccountId: account.id,
        code: invite.code,
        address: 'Fixture building',
        roomNumber: '101',
      });
    }
    for (const name of ['staff-one', 'staff-two'])
      db.setParkServiceSpecialist({
        parkId: park.id,
        actorAccountId: parkAdmin.id,
        serviceId: 'repair',
        accountId: actors.get(name)!.account.id,
      });
    return { base, db, actors, api, requests, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export type EnterpriseFixture = Awaited<
  ReturnType<typeof startEnterpriseFixture>
>;

export async function executeTenantBoundary(
  fixture: EnterpriseFixture,
  journal: EvidenceJournal,
): Promise<Observation[]> {
  const { api, actors, db } = fixture;
  const a = actors.get('a-admin')!.account;
  const b = actors.get('b-admin')!.account;
  const privateMarker = `private-${randomUUID()}`;
  const saved = await api(
    'a-admin',
    'PUT',
    '/enterprise/organization/public-profile',
    {
      summary: privateMarker,
      productsServices: ['private product'],
      publicContact: 'not-public',
      isPublic: false,
    },
  );
  const own = await api(
    'a-admin',
    'GET',
    '/enterprise/organization/public-profile',
  );
  const foreignRead = await api(
    'b-admin',
    'GET',
    `/enterprise/organization/public-profile?organizationId=${a.organizationId}`,
  );
  const nonAdminWrite = await api(
    'b-member',
    'PUT',
    '/enterprise/organization/public-profile',
    { organizationId: a.organizationId, summary: 'intrusion', isPublic: true },
  );
  const forgedAdminWrite = await api(
    'b-admin',
    'PUT',
    '/enterprise/organization/public-profile',
    {
      organizationId: a.organizationId,
      summary: 'foreign mutation',
      isPublic: false,
    },
  );
  const stars = await api('b-admin', 'GET', '/enterprise/park/star-map');
  const persistedA = db.getEnterprisePublicProfile(a.organizationId);
  const persistedB = db.getEnterprisePublicProfile(b.organizationId);
  const state = await journal.add('independent-profile-state.json', {
    persistedA,
    persistedB,
    privateMarker,
  });
  const responses = await journal.add(
    'tenant-api-responses.json',
    fixture.requests,
  );
  return [
    {
      check: 'api-responses',
      passed:
        saved.status === 200 &&
        own.status === 200 &&
        foreignRead.status === 200 &&
        stars.status === 200,
      evidence: [responses],
    },
    {
      check: 'own-profile-persisted',
      passed:
        persistedA.summary === privateMarker &&
        own.data.profile.summary === privateMarker,
      evidence: [state, responses],
    },
    {
      check: 'cross-tenant-denied',
      passed:
        nonAdminWrite.status === 403 &&
        persistedA.summary === privateMarker &&
        persistedB.organizationId === b.organizationId &&
        (forgedAdminWrite.status === 403 ||
          forgedAdminWrite.data.profile?.organizationId === b.organizationId),
      evidence: [responses, state],
      reason:
        "Non-admin PUT is denied. Forged organizationId by another admin must remain scoped to that admin's own tenant, never mutate A.",
    },
    {
      check: 'private-fields-hidden',
      passed:
        !JSON.stringify(foreignRead.data).includes(privateMarker) &&
        !JSON.stringify(stars.data).includes(privateMarker),
      evidence: [responses],
    },
  ];
}
export async function executeParkReplies(
  fixture: EnterpriseFixture,
  journal: EvidenceJournal,
): Promise<{ observations: Observation[]; ticketId: string }> {
  const { api, db, actors } = fixture;
  const created = await api('a-member', 'POST', '/enterprise/tickets', {
    serviceId: 'repair',
    title: 'Evaluation repair',
    description: 'Light is broken',
    category: '水电',
    location: 'Fixture 101',
    urgency: '普通',
    contact: 'Fixture applicant',
    contactPhone: '13800138000',
  });
  if (created.status !== 201)
    throw new Error(`Ticket creation failed: ${JSON.stringify(created.data)}`);
  const id = created.data.ticket.id as string;
  const replies: Array<{ status: number; data: Record<string, unknown> }> = [];
  for (const [actor, action] of [
    ['staff-one', { action: 'accept' }],
    [
      'staff-one',
      {
        action: 'respond',
        responseText: 'First staff inspected the light.',
        responseType: '处理中',
      },
    ],
    [
      'staff-one',
      { action: 'release', releaseReason: 'Second staff will finish.' },
    ],
    ['staff-two', { action: 'accept' }],
    [
      'staff-two',
      {
        action: 'respond',
        responseText: 'Second staff arranged repair.',
        responseType: '处理中',
      },
    ],
  ] as const)
    replies.push(
      await api(actor, 'POST', `/enterprise/tickets/${id}/action`, action),
    );
  const inbox = await api('a-member', 'GET', '/enterprise/tickets');
  const record = db.getTicketForAccount(id, actors.get('a-member')!.account.id);
  const responses = await journal.add(
    'park-api-responses.json',
    fixture.requests,
  );
  const state = await journal.add('independent-ticket-state.json', record);
  const history = record?.history ?? [];
  const staffIds = ['staff-one', 'staff-two'].map(
    (name) => actors.get(name)!.account.id,
  );
  return {
    ticketId: id,
    observations: [
      {
        check: 'api-responses',
        passed: replies.every((r) => r.status === 200) && inbox.status === 200,
        evidence: [responses],
      },
      {
        check: 'ticket-conversation',
        passed:
          JSON.stringify(inbox.data).includes(id) &&
          record?.creator.id === actors.get('a-member')!.account.id,
        evidence: [responses, state],
      },
      {
        check: 'staff-identities',
        passed: staffIds.every((staffId) =>
          history.some(
            (h) => h.action === 'respond' && h.actor?.id === staffId,
          ),
        ),
        evidence: [state],
      },
    ],
  };
}
