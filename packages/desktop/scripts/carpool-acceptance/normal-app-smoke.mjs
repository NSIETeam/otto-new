/** Actual Desktop main/preload/App login probe; public map and later journeys remain separately gated. */
import process from 'node:process';
import console from 'node:console';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const temp = await mkdtemp(path.join(tmpdir(), 'otto-carpool-normal-app-'));
const evidence = path.join(root, 'docs/research/carpool-delivery/evidence');
process.env.OTTO_ENTERPRISE_DIR = path.join(temp, 'enterprise');
process.env.OTTO_ENTERPRISE_PUBLIC_BASE_URL = 'http://127.0.0.1';
const licenseKeys = generateKeyPairSync('ed25519');
process.env.OTTO_LICENSE_PUBLIC_KEY = licenseKeys.publicKey
  .export({ format: 'pem', type: 'spki' })
  .toString();
process.env.OTTO_DATABASE_ENCRYPTION_KEY_FILE = path.join(temp, 'custody.key');
await writeFile(
  process.env.OTTO_DATABASE_ENCRYPTION_KEY_FILE,
  randomBytes(32),
  { mode: 0o600 },
);
for (const flag of ['REQUESTS', 'INVITATIONS', 'GROUPS'])
  process.env[`OTTO_PARK_CARPOOL_${flag}_ENABLED`] = 'true';
let app;
let server;
try {
  const db = await import(
    path.join(root, 'packages/server/dist/src/enterprise/db.js')
  );
  const { startEnterpriseServer } = await import(
    path.join(root, 'packages/server/dist/src/enterprise/server.js')
  );
  const authority = db.createAccount({
    username: 'carpool.operator',
    password: 'Carpool-local-only-926!',
    name: '本地验收管理员',
    isAdmin: true,
  });
  const { signEd25519Envelope } = await import(
    path.join(
      root,
      'packages/server/dist/src/modules/commercial_control/signedEnvelope.js',
    )
  );
  const license = {
    id: 'local-carpool-acceptance-license',
    deploymentId: db.getDeploymentId(),
    organizationId: authority.organizationId,
    machineFingerprint: db.getMachineFingerprint(),
    customerName: 'Disposable local carpool acceptance',
    plan: 'enterprise',
    expiresAtMs: Date.now() + 86400000,
    seatLimit: 20,
    modules: [
      'enterprise_tree',
      'direct_messages',
      'park_services',
      'knowledge',
      'atoa',
      'skill_market',
    ],
    offline: true,
    telemetryAllowed: false,
    issuedAtMs: Date.now(),
  };
  db.importDeploymentLicense({
    license,
    signature: signEd25519Envelope(
      license,
      licenseKeys.privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString(),
    ),
  });
  const park = db.createPark({
    adminOrganizationId: authority.organizationId,
    actorAccountId: authority.id,
    name: '拼车本地验收园区',
  });
  for (const name of ['alice', 'bob', 'carol']) {
    const org = db.createOrganization({
      name: `拼车验收企业-${name}`,
      slug: `carpool-${name}`,
    });
    const member = db.createAccount({
      organizationId: org.id,
      username: `carpool.${name}`,
      password: 'Carpool-local-only-926!',
      name: `验收-${name}`,
      isAdmin: true,
    });
    const invite = db.issueParkInvite({
      parkId: park.id,
      actorAccountId: authority.id,
    });
    db.joinOrganizationToPark({
      organizationId: org.id,
      actorAccountId: member.id,
      code: invite.code,
      address: '公共园区',
      roomNumber: '验收',
    });
  }
  server = startEnterpriseServer({
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1',
    adminToken: 'local-carpool-fixture-admin',
    smsSender: null,
    repairSmsSender: null,
    repairFeishuSender: null,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const wrapper = path.join(temp, 'normal-main.cjs');
  await writeFile(
    wrapper,
    `const {app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp, 'desktop-profile'))});require(${JSON.stringify(path.join(root, 'packages/desktop/dist/main/index.js'))});`,
  );
  const desktopEnv = { ...process.env };
  delete desktopEnv.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [wrapper],
    env: {
      ...desktopEnv,
      OTTO_USER_DATA_DIR: path.join(temp, 'desktop-profile'),
      OTTO_USER_DIR: path.join(temp, 'user'),
      OTTO_ENTERPRISE_SERVER_URL: base,
      OTTO_SERVER_PORT: '0',
    },
    timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  const preparation = await page.evaluate(async (base) => {
    try {
      return await globalThis.otto.enterprisePrepareServer({ serverUrl: base });
    } catch (error) {
      return { error: error.message };
    }
  }, base);
  await writeFile(
    path.join(evidence, 'repair-pass-2-normal-app-registered-readiness.json'),
    JSON.stringify(preparation, null, 2),
  );
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await page.getByRole('button', { name: '密码登录', exact: true }).click();
  await page.getByLabel('账号或手机号', { exact: true }).fill('carpool.alice');
  await page
    .getByLabel('密码', { exact: true })
    .fill('Carpool-local-only-926!');
  const login = page.getByRole('button', { name: '进入 Otto', exact: true });
  let loginCompleted = false;
  if (await login.isEnabled()) {
    await login.click();
    await page
      .getByRole('button', { name: '进入 Otto', exact: true })
      .waitFor({ state: 'hidden', timeout: 30000 });
    loginCompleted = true;
  }

  await writeFile(
    path.join(evidence, 'repair-pass-2-normal-app-registered-initial.txt'),
    await page.locator('body').innerText(),
  );
  await page.screenshot({
    path: path.join(
      evidence,
      'repair-pass-2-normal-app-registered-initial.png',
    ),
  });
  console.log(
    JSON.stringify({
      status: loginCompleted ? 'login_passed' : 'external_blocked',
      localTestLicense: true,
      normalMain: true,
      normalPreload: true,
      normalApp: true,
      localEnterpriseServer: true,
      testOrganizations: 3,
      loginCompleted,
      threeStageJourney: false,
      mapConfigured: Boolean(process.env.OTTO_AMAP_WEB_SERVICE_KEY),
    }),
  );
  if (!loginCompleted) process.exitCode = 2;
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'failed',
      reason: String(error.message).replace(
        /Carpool-local-only-926!/g,
        '[fixture-password]',
      ),
      temp,
    }),
  );
  process.exitCode = 1;
} finally {
  await app?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
