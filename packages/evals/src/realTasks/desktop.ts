/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page, Locator } from 'playwright';
import type { EnterpriseFixture } from './enterprise.js';
import {
  confinedFile,
  EvidenceJournal,
  sha256,
  type Observation,
} from './evidence.js';

/** A separately built, hash-bound product app, not renderer/jsdom with a fake bridge. */
export interface DesktopBuildWitness {
  sourceFingerprint: string;
  buildDirectory: string;
  entry: string;
  files: Array<{ path: string; sha256: string }>;
}
export async function verifyDesktopBuild(
  witness: DesktopBuildWitness,
  expectedSource: string,
) {
  if (
    witness.sourceFingerprint !== expectedSource ||
    !/^[a-f\d]{64}$/u.test(expectedSource)
  )
    throw new Error('Desktop build does not match the experiment source');
  for (const required of [
    'dist/main/index.js',
    'dist/preload/index.js',
    'dist/renderer/index.html',
  ]) {
    if (!witness.files.some((f) => f.path === required))
      throw new Error(`Unsealed desktop component: ${required}`);
  }
  if (!witness.files.some((f) => /dist\/renderer\/.+\.js$/u.test(f.path)))
    throw new Error('Renderer JS is not sealed');
  if (witness.entry !== 'dist/main/index.js')
    throw new Error('Only the real product main entry is allowed');
  for (const file of witness.files) {
    if (
      sha256(
        await readFile(await confinedFile(witness.buildDirectory, file.path)),
      ) !== file.sha256
    )
      throw new Error(`Stale/changed desktop build: ${file.path}`);
  }
}

export class ProductDesktopDriver {
  private actions: Array<{
    at: number;
    action: string;
    target: string;
    completedAt?: number;
  }> = [];
  private constructor(
    readonly page: Page,
    readonly journal: EvidenceJournal,
  ) {}
  static async attach(
    app: ElectronApplication,
    witness: DesktopBuildWitness,
    expectedSource: string,
    isolatedProfile: string,
    journal: EvidenceJournal,
  ) {
    await verifyDesktopBuild(witness, expectedSource);
    const actual = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      main: process.argv[1],
      pid: process.pid,
    }));
    if (
      (await realpath(actual.userData)) !== (await realpath(isolatedProfile)) ||
      (await realpath(actual.main)) !==
        (await realpath(path.join(witness.buildDirectory, witness.entry)))
    )
      throw new Error('Not the owned isolated product process');
    const expectedUrl = new URL(
      `file:///${path.join(witness.buildDirectory, 'dist/renderer/index.html').replace(/\\/gu, '/')}`,
    ).href;
    const page = app
      .windows()
      .find((p) => p.url().split('?')[0] === expectedUrl);
    if (!page) throw new Error('Actual product renderer not loaded');
    await journal.add('desktop-identity.json', {
      ...actual,
      sourceFingerprint: expectedSource,
      buildFiles: witness.files,
    });
    return new ProductDesktopDriver(page, journal);
  }
  private async click(
    target: Locator,
    description: string,
    button: 'left' | 'right' = 'left',
  ) {
    const action = {
      at: Date.now(),
      action: `${button}-click`,
      target: description,
      completedAt: undefined as number | undefined,
    };
    this.actions.push(action);
    if ((await target.count()) !== 1)
      throw new Error(`Ambiguous or missing product control: ${description}`);
    await target.click({ button, timeout: 10000 });
    action.completedAt = Date.now();
  }
  async openInbox() {
    await this.click(
      this.page
        .locator('.otto-sidebar__nav')
        .getByRole('button', { name: '我的消息', exact: true }),
      '我的消息',
    );
  }
  async awayAndBack() {
    await this.click(
      this.page
        .locator('.otto-sidebar__nav')
        .getByRole('button', { name: '工作台', exact: true }),
      '离开：工作台',
    );
    await this.page
      .getByRole('list', { name: '会话列表' })
      .waitFor({ state: 'hidden', timeout: 10000 });
    await this.openInbox();
    await this.click(
      this.page.getByRole('tab', { name: /^全部 /u }),
      '全部消息（不使用未读过滤）',
    );
  }
  private async trace() {
    const clicks = await this.journal.add('ui-clicks.json', this.actions);
    const screenshot = await this.journal.add(
      'ui-screenshot.png',
      await this.page.screenshot({ fullPage: false }),
      true,
    );
    return [
      {
        check: 'ui-clicks',
        passed:
          this.actions.length > 0 && this.actions.every((a) => !!a.completedAt),
        evidence: [clicks],
      },
      {
        check: 'ui-screenshot',
        passed: true,
        evidence: [screenshot],
        reason:
          'Captured real product pixels; visual fidelity still requires human review',
      },
    ] satisfies Observation[];
  }
  async inboxReadReturn(
    fixture: EnterpriseFixture,
    recipientId: string,
    senderId: string,
    senderName: string,
    messageId: string,
    expectedText: string,
  ): Promise<Observation[]> {
    const state = () =>
      fixture.db
        .getDB()
        .prepare(
          'SELECT id, sender_account_id, recipient_account_id, read_at FROM direct_messages WHERE id = ?',
        )
        .get(messageId) as
        | {
            id: string;
            sender_account_id: string;
            recipient_account_id: string;
            read_at: string | null;
          }
        | undefined;
    const before = state();
    if (
      !before ||
      before.read_at !== null ||
      before.sender_account_id !== senderId ||
      before.recipient_account_id !== recipientId
    )
      throw new Error(
        'The fixture must contain a REAL encrypted unread message for this account',
      );
    await this.openInbox();
    const peer = () =>
      this.page
        .getByRole('list', { name: '会话列表' })
        .getByRole('listitem')
        .filter({ has: this.page.locator('strong', { hasText: senderName }) });
    await this.click(peer(), `读取联系人 ${senderName}`);
    await this.page
      .locator('.otto-inbox-page__detail')
      .getByText(expectedText, { exact: true })
      .waitFor({ timeout: 15000 });
    await this.awayAndBack();
    await peer().waitFor({ state: 'visible', timeout: 10000 });
    const atReturn = state();
    const visibleAtReturn = (await peer().count()) === 1;
    // Observe one complete real 8-second poll interval. Do not trigger a GET
    // messages read endpoint in the oracle: that would itself mark the row read.
    await new Promise((resolve) => setTimeout(resolve, 9000));
    const after = state();
    const evidence = await this.journal.add('independent-message-state.json', {
      before,
      atReturn,
      after,
      peerLabel: await peer().getAttribute('aria-label'),
    });
    return [
      ...(await this.trace()),
      {
        check: 'persistent-conversation',
        passed: visibleAtReturn && after?.id === before.id,
        evidence: [evidence, 'ui-screenshot.png'],
      },
      {
        check: 'no-repeat-unread',
        passed:
          !!atReturn?.read_at &&
          !!after?.read_at &&
          (await peer().locator('.otto-inbox-page__unread').count()) === 0,
        evidence: [evidence, 'ui-screenshot.png'],
      },
    ];
  }
  async removeProject(input: {
    isolatedRoot: string;
    projectDirectory: string;
    retainedFiles: string[];
    retainedSessionFiles: string[];
  }): Promise<Observation[]> {
    const project = await realpath(input.projectDirectory);
    if (!input.retainedFiles.length || !input.retainedSessionFiles.length)
      throw new Error('Independent file/session retention fixtures required');
    const files = [...input.retainedFiles, ...input.retainedSessionFiles];
    const before = await Promise.all(
      files.map(async (file) => ({
        file,
        hash: sha256(
          await readFile(await confinedFile(input.isolatedRoot, file)),
        ),
      })),
    );
    // Folder and history must be in the disposable fixture, never user projects.
    const relation = path.relative(await realpath(input.isolatedRoot), project);
    if (!relation || relation.startsWith('..') || path.isAbsolute(relation))
      throw new Error('Project is outside disposable fixture');
    const toggle = this.page
      .getByTitle(project, { exact: true })
      .and(this.page.locator('.otto-workspace-group__toggle'));
    await this.click(toggle, `项目菜单 ${project}`, 'right');
    await this.click(
      this.page
        .getByRole('menu', { name: '项目操作' })
        .getByRole('menuitem', { name: '删除项目', exact: true }),
      '从列表删除此测试项目',
    );
    await this.click(
      this.page
        .getByRole('dialog')
        .getByRole('button', { name: '删除项目', exact: true }),
      '确认移除（不删除文件）',
    );
    await toggle.waitFor({ state: 'hidden', timeout: 10000 });
    await this.page.reload();
    await this.page.locator('.otto-sidebar__nav').waitFor({ timeout: 15000 });
    const after = await Promise.all(
      files.map(async (file) => {
        try {
          return {
            file,
            hash: sha256(
              await readFile(await confinedFile(input.isolatedRoot, file)),
            ),
          };
        } catch {
          return { file, hash: null };
        }
      }),
    );
    const storage = await this.page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((k) => k.startsWith('otto.session-list.v1'))
          .map((k) => [
            k,
            JSON.parse(localStorage.getItem(k) ?? 'null') as {
              removedProjectPaths?: string[];
            } | null,
          ]),
      ),
    );
    const evidence = await this.journal.add('project-retention.json', {
      project,
      before,
      after,
      storage,
    });
    const retained = (names: string[]) =>
      names.every(
        (name) =>
          after.find((a) => a.file === name)?.hash ===
          before.find((a) => a.file === name)?.hash,
      );
    return [
      ...(await this.trace()),
      {
        check: 'project-removed',
        passed:
          (await toggle.count()) === 0 &&
          Object.values(storage).some((v) =>
            v?.removedProjectPaths?.some(
              (p) =>
                path.normalize(p).toLowerCase() ===
                path.normalize(project).toLowerCase(),
            ),
          ),
        evidence: [evidence, 'ui-screenshot.png'],
      },
      {
        check: 'files-retained',
        passed: retained(input.retainedFiles),
        evidence: [evidence],
      },
      {
        check: 'other-session-retained',
        passed: retained(input.retainedSessionFiles),
        evidence: [evidence],
      },
    ];
  }
  async previewArtifact(
    workspace: string,
    name: string,
  ): Promise<Observation[]> {
    const file = await confinedFile(workspace, name);
    const hashBefore = sha256(await readFile(file));
    const link = this.page
      .locator('a.otto-local-path__preview-link')
      .filter({ hasText: name });
    await this.click(link, `打开实际交付链接 ${name}`);
    const dialog = this.page.getByRole('dialog', {
      name: `预览 ${name}`,
      exact: true,
    });
    await dialog.waitFor({ timeout: 15000 });
    await dialog
      .locator('.otto-presentation-preview__canvas img')
      .first()
      .waitFor({ timeout: 15000 });
    const screenshots = [];
    for (let page = 1; page <= 3; page++) {
      await this.click(
        dialog.getByRole('button', { name: `查看第 ${page} 页`, exact: true }),
        `预览第 ${page} 页`,
      );
      screenshots.push(
        await this.journal.add(
          `preview-page-${page}.png`,
          await dialog.screenshot(),
          true,
        ),
      );
    }
    const click = await this.journal.add('preview-clicks.json', {
      actions: this.actions,
      fileHashBefore: hashBefore,
      fileHashAfter: sha256(await readFile(file)),
      file,
    });
    return [
      {
        check: 'preview-click',
        passed: hashBefore === sha256(await readFile(file)),
        evidence: [click],
      },
      {
        check: 'preview-screenshot',
        passed: true,
        evidence: screenshots,
        reason: 'Actual visible pages, not a claim of original-layout fidelity',
      },
      {
        check: 'external-process-monitor',
        passed: null,
        evidence: [],
        reason:
          'Requires full-window-lifetime OS process-start monitor AND shell-open audit; screenshots cannot establish no external launch.',
      },
    ];
  }
  async parkConversation(
    fixture: EnterpriseFixture,
    ticketId: string,
    applicantId: string,
    applicationNumber: string,
    expectedReplies: string[],
  ): Promise<Observation[]> {
    if (expectedReplies.length !== 2)
      throw new Error('Two distinct staff replies required');
    await this.openInbox();
    const row = this.page
      .getByRole('list', { name: '会话列表' })
      .getByRole('listitem')
      .filter({ hasText: applicationNumber });
    await this.click(row, `报修会话 ${applicationNumber}`);
    for (const text of expectedReplies)
      await this.page
        .locator('.otto-inbox-page__detail')
        .getByText(text, { exact: true })
        .waitFor({ timeout: 10000 });
    await this.awayAndBack();
    await row.waitFor({ state: 'visible', timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 9000));
    const record = fixture.db.getTicketForAccount(ticketId, applicantId);
    const evidence = await this.journal.add(
      'after-ui-ticket-state.json',
      record,
    );
    return [
      ...(await this.trace()),
      {
        check: 'no-repeat-unread',
        passed: (await row.locator('.otto-inbox-page__unread').count()) === 0,
        evidence: [evidence, 'ui-screenshot.png'],
      },
    ];
  }
}
