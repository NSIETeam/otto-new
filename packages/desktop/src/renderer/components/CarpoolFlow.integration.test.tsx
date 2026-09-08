import { carpoolTestConfig, carpoolTestNativeBinary } from '../../main/park-carpool-test-support.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
  cleanup,
} from '@testing-library/react';
import {
  Database,
  createEncryptedFieldCipher,
  createParkCarpoolService,
  createParkCarpoolSqliteStore,
  PARK_CARPOOL_SCHEMA_CONTRIBUTOR,
} from 'otto-server';
import { ParkCarpoolChat } from '../../main/park-carpool-chat.js';
import { ParkCarpoolDialog } from './ParkCarpoolDialog.js';
import { CarpoolRequestCenter } from './CarpoolRequestCenter.js';

it('real UI publishes, previews, requests, chats, groups, admits and leaves through SQLite and native MLS', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'otto-carpool-flow-'));
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE accounts(id TEXT PRIMARY KEY);CREATE TABLE organizations(id TEXT PRIMARY KEY);INSERT INTO accounts VALUES ('a'),('b'),('c');INSERT INTO organizations VALUES ('org-a'),('org-b'),('org-c');CREATE TABLE e2ee_devices(account_id TEXT,organization_id TEXT,device_id TEXT,approval_state TEXT,revoked_at TEXT);INSERT INTO e2ee_devices VALUES ('a','org-a','device-a','approved',NULL),('b','org-b','device-b','approved',NULL),('c','org-c','device-c','approved',NULL);",
  );
  PARK_CARPOOL_SCHEMA_CONTRIBUTOR.apply(db);
  const store = createParkCarpoolSqliteStore({
    db: () => db,
    fieldCipher: createEncryptedFieldCipher({
      keyProvider: {
        getKey: () => Buffer.alloc(32, 17),
        clear: () => undefined,
      },
    }),
    getPrincipal: (id) =>
      ['a', 'b', 'c'].includes(id)
        ? {
            accountId: id,
            organizationId: `org-${id}`,
            organizationName: `测试企业${id}`,
            displayName: `${id}同事`,
            parkId: 'park-ui',
            active: true,
            parkServiceEnabled: true,
          }
        : null,
  });
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const places = [
    {
      id: 'origin',
      label: '测试园区南门',
      address: '公共出口',
      district: '测试区',
      coordinate: { longitude: 116, latitude: 40 },
    },
    {
      id: 'destination',
      label: '测试地铁站',
      address: '公共站口',
      district: '测试区',
      coordinate: { longitude: 116.1, latitude: 40 },
    },
  ];
  const service = createParkCarpoolService({ config: carpoolTestConfig,
    store,
    createId: (id) => `intent-${id}`,
    mapProvider: {
      configured: true,
      searchPlaces: async (query) =>
        query.includes('园区') ? [places[0]!] : [places[1]!],
      planDrivingRoute: async (a, b) => ({
        provider: 'explicit-local-map-fixture',
        distanceMeters: 8500,
        durationSeconds: 1200,
        polyline: [a, b],
      }),
    },
  });
  const chats = new Map(
    ['a', 'b', 'c'].map((id) => [
      id,
      new ParkCarpoolChat({
        stateDirectory: directory,
        binaryPath: carpoolTestNativeBinary(),
        secureStorage: {
          assertAvailable: () => undefined,
          protect: (s) => `test-only:${s}`,
          unprotect: (s) => s.slice(10),
        },
        client: {
          getParkCarpoolWorkflow: () => service.getWorkflow(id),
          executeParkCarpoolTransport: (command) =>
            service.executeTransport(id, command),
        },
      }),
    ]),
  );
  const bind = (id: string) =>
    Object.assign(window.otto, {
      enterpriseParkCarpoolGet: () => service.getState(id),
      enterpriseParkCarpoolRefresh: (query?: {
        cursor?: string;
        filter?: string;
      }) => service.refreshMatches(id, query),
      enterpriseParkCarpoolSearchPlaces: (query: string) =>
        service.searchPlaces(id, query),
      enterpriseParkCarpoolPublish: (
        input: Parameters<typeof service.publishIntent>[1],
      ) => service.publishIntent(id, input),
      enterpriseParkCarpoolStop: (intentId: string) =>
        service.stopIntent(id, intentId),
      enterpriseParkCarpoolConfirm: (intentId: string) =>
        service.confirmIntent(id, intentId),
      enterpriseParkCarpoolRoutePreview: (intentId: string, groupId?: string) =>
        service.routePreview(id, intentId, groupId),
      enterpriseParkCarpoolWorkflowGet: () => service.getWorkflow(id),
      enterpriseParkCarpoolWorkflowExecute: (
        command: Parameters<typeof service.executeWorkflow>[1],
      ) => service.executeWorkflow(id, command),
      enterpriseParkCarpoolChatRead: (conversationId: string) =>
        chats.get(id)!.read(conversationId),
      enterpriseParkCarpoolChatSend: (
        conversationId: string,
        text: string,
        eventId: string,
      ) => chats.get(id)!.send(conversationId, text, eventId),
    });
  const show = (id: string, dialog = false) => {
    cleanup();
    bind(id);
    return render(
      dialog ? (
        <ParkCarpoolDialog open onClose={() => undefined} />
      ) : (
        <CarpoolRequestCenter />
      ),
    );
  };
  const input = {
    travelDate: today,
    departureTime: `${today}T23:00:00+08:00`,
    flexibleMinutes: 30,
    origin: places[0]!,
    destination: places[1]!,
    travelOptions: ['shared_taxi'] as const,
  };
  const fillRequest = async (message: string) => {
    fireEvent.change(screen.getByLabelText('首条消息'), {
      target: { value: message },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送请求' }));
    await waitFor(() => expect(screen.queryByLabelText('首条消息')).toBeNull());
  };
  try {
    for (const [id, chat] of chats)
      await chat.activate({
        serverUrl: 'http://127.0.0.1:54321',
        organizationId: `org-${id}`,
        accountId: id,
        deviceId: `device-${id}`,
        approvalState: 'approved',
      });
    await service.publishIntent('b', { ...input, requestKey: 'ui-peer-b' });
    show('a', true);
    await screen.findByText('找到与你方向相近的园区伙伴');
    for (const [name, query, label] of [
      ['从哪里出发', '园区', '测试园区南门'],
      ['要去哪里', '地铁', '测试地铁站'],
    ]) {
      const group = screen.getByRole('group', { name });
      fireEvent.change(
        within(group).getByPlaceholderText('搜索小区、地标或地址'),
        { target: { value: query } },
      );
      fireEvent.click(within(group).getByRole('button', { name: '搜索' }));
      fireEvent.click(
        await screen.findByRole('option', { name: new RegExp(label!) }),
      );
    }
    fireEvent.change(screen.getByLabelText('计划出发时间'), {
      target: { value: `${today}T23:00` },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /一起叫车/ }));
    fireEvent.click(screen.getByRole('button', { name: '发布并查找同路伙伴' }));
    fireEvent.click(
      await screen.findByRole('button', { name: '查看路线对比' }),
    );
    await screen.findByText(/深色实线：双方或全员共同方向/);
    fireEvent.click(screen.getByRole('button', { name: '发消息' }));
    await fillRequest('先聊聊行程');
    await screen.findByText('已发送请求，等待确认');
    show('b');
    fireEvent.click(await screen.findByRole('button', { name: '接受聊天' }));
    await waitFor(async () =>
      expect((await service.getWorkflow('b')).conversations).toHaveLength(1),
    );
    const direct = (await service.getWorkflow('a')).conversations[0]!.id;
    await chats.get('a')!.read(direct);
    await chats.get('b')!.read(direct);
    show('a');
    fireEvent.click(
      await screen.findByRole('button', { name: '打开同行私聊' }),
    );
    await screen.findByText('端到端加密已就绪');
    fireEvent.change(screen.getByLabelText('同行消息'), {
      target: { value: '独立私聊历史' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送加密消息' }));
    await screen.findByText('独立私聊历史');
    await waitFor(async () =>
      expect((await chats.get('b')!.read(direct)).messages[0]?.text).toBe(
        '独立私聊历史',
      ),
    );
    show('a', true);
    fireEvent.click(await screen.findByRole('button', { name: '邀请同行' }));
    fireEvent.change(screen.getByLabelText('本次同行方式'), {
      target: { value: 'shared_taxi' },
    });
    await fillRequest('明确一起叫车');
    show('b');
    fireEvent.click(
      await screen.findByRole('button', { name: '接受同行邀请' }),
    );
    await waitFor(async () =>
      expect((await service.getWorkflow('b')).myGroup?.members).toHaveLength(2),
    );
    const groupChat = (await service.getWorkflow('a')).myGroup!.conversationId;
    const myGroupCard = screen.getByText('我的同行组').closest('article')!;
    fireEvent.click(
      within(myGroupCard).getByRole('button', { name: '查看路线对比' }),
    );
    await within(myGroupCard).findByText(/深色实线：双方或全员共同方向/);
    await chats.get('a')!.read(groupChat);
    await chats.get('b')!.read(groupChat);
    await chats.get('a')!.send(groupChat, '两人阶段群聊历史', 'before-c');
    vi.stubEnv('OTTO_PARK_CARPOOL_GROUPS_ENABLED', 'false');
    show('b');
    fireEvent.click(
      await screen.findByRole('button', { name: '打开同行群聊' }),
    );
    await screen.findByText('两人阶段群聊历史');
    vi.unstubAllEnvs();
    await service.publishIntent('c', { ...input, requestKey: 'ui-peer-c' });
    show('c', true);
    fireEvent.click(
      await screen.findByRole('button', { name: '申请加入同行组' }),
    );
    await fillRequest('申请加入这次同行');
    await screen.findByText('已发送请求，等待确认');
    show('a');
    fireEvent.click(await screen.findByRole('button', { name: '同意入组' }));
    await waitFor(async () =>
      expect((await service.getWorkflow('c')).myGroup?.members).toHaveLength(3),
    );
    await chats.get('a')!.read(groupChat);
    await chats.get('b')!.read(groupChat);
    await chats.get('c')!.read(groupChat);
    await chats.get('a')!.send(groupChat, '三人同行的新消息', 'after-c');
    await chats.get('b')!.send(groupChat, '另一位同行成员的消息', 'from-b');
    const cHistory = await chats.get('c')!.read(groupChat);
    expect(cHistory.messages.map((message) => message.text)).toEqual([
      '三人同行的新消息',
      '另一位同行成员的消息',
    ]);
    expect(
      new Set(cHistory.messages.map((message) => message.senderDisplayName))
        .size,
    ).toBe(2);
    show('c');
    fireEvent.click(
      await screen.findByRole('button', { name: '打开同行群聊' }),
    );
    await screen.findByText('三人同行的新消息');
    fireEvent.click(
      within(screen.getByText('三人同行的新消息').closest('li')!).getByRole(
        'button',
        { name: '举报此消息' },
      ),
    );
    fireEvent.change(screen.getByLabelText('举报原因'), {
      target: { value: '验收测试，主动提交单条消息' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认提交举报' }));
    await screen.findByText(/举报已提交/);
    expect((await service.getWorkflow('c')).reports[0]?.evidence).toMatchObject(
      { kind: 'chat_message', firstMessage: '三人同行的新消息' },
    );
    show('c');
    fireEvent.click(
      await screen.findByRole('button', { name: '退出同行组，继续个人寻找' }),
    );
    await waitFor(async () =>
      expect((await service.getWorkflow('c')).myGroup).toBeNull(),
    );
    expect((await service.getWorkflow('a')).myGroup?.members).toHaveLength(2);
    await chats.get('a')!.read(groupChat);
    await chats.get('b')!.read(groupChat);
    await chats.get('a')!.send(groupChat, '退出后的消息', 'after-c-left');
    expect(
      (await chats.get('c')!.read(groupChat)).messages.some(
        (message) => message.text === '退出后的消息',
      ),
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    cleanup();
    await Promise.all([...chats.values()].map((chat) => chat.close()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
