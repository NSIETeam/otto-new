/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { CarpoolRequestCenter } from './components/CarpoolRequestCenter.js';
import { ParkCarpoolDialog } from './components/ParkCarpoolDialog.js';
import { Database, createEncryptedFieldCipher, createParkCarpoolService, createParkCarpoolSqliteStore, PARK_CARPOOL_SCHEMA_CONTRIBUTOR } from 'otto-server';
import { handleParkCarpoolConversation, ParkCarpoolConversationRegistry } from './parkCarpoolConversationBridge.js';

const fixed = new Date('2026-09-08T00:00:00Z');
const publish = {
  requestKey: 'request-contract-1', travelDate: '2026-09-08',
  origin: { label: '测试园区南门', coordinate: { longitude: 116, latitude: 40 } },
  destination: { label: '测试地铁站', coordinate: { longitude: 116.1, latitude: 40 } },
  departureTime: '2026-09-08T18:30:00+08:00', flexibleMinutes: 30,
  travelOptions: ['shared_taxi'] as const,
};
async function sqliteHarness() {
  const database = new Database(':memory:');
  database.exec("CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE accounts(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-a'); INSERT INTO accounts VALUES ('a'), ('b');");
  PARK_CARPOOL_SCHEMA_CONTRIBUTOR.apply(database);
  const store = createParkCarpoolSqliteStore({ db: () => database, fieldCipher: createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 19), clear: () => undefined } }),
    getPrincipal: id => database.prepare('SELECT id FROM accounts WHERE id = ?').get(id) ? { accountId: id, organizationId: 'org-a', organizationName: '测试企业', displayName: '测试用户', parkId: 'park-a', active: true, parkServiceEnabled: true } : null,
  });
  return { store, close: async () => database.close() };
}

it('passes real conversation output through the real service and encrypted SQLite, rejects stale drafts', async () => {
  const h = await sqliteHarness();
  const service = createParkCarpoolService({ store: h.store, now: () => fixed, createId: id => `intent-${id}`, mapProvider: {
    configured: true,
    searchPlaces: async query => [{ id: query, label: query, district: '测试区', address: '', coordinate: query.includes('南门') ? publish.origin.coordinate : publish.destination.coordinate }],
    planDrivingRoute: async (origin, destination) => ({ provider: 'synthetic-contract-fixture', distanceMeters: 8500, durationSeconds: 1200, polyline: [origin, destination] }),
  } });
  const messages: string[] = [];
  const common = {
    registry: new ParkCarpoolConversationRegistry(), scopeId: 'org-a:a', sessionId: 'session-test', now: () => fixed,
    getState: () => service.getState('a'), searchPlaces: (query: string) => service.searchPlaces('a', query),
    publish: (input: Parameters<typeof service.publishIntent>[1]) => service.publishIntent('a', input),
    stop: (id: string) => service.stopIntent('a', id), postMessage: (_role: 'user' | 'assistant', text: string) => messages.push(text),
  };
  try {
    await handleParkCarpoolConversation({ ...common, text: '我要拼车，今天下午3点从测试南门到测试地铁站，想搭车' });
    await handleParkCarpoolConversation({ ...common, text: '前后20分钟都可以' });
    await handleParkCarpoolConversation({ ...common, text: '确认发布' });
    const saved = (await h.store.getIntent('a'))!;
    expect(saved.departureTime).toBe('2026-09-08T07:00:00.000Z');
    expect(saved.flexibleMinutes).toBe(20);
    expect(saved.version).toBe(1);
    await handleParkCarpoolConversation({ ...common, text: '修改拼车信息，前后10分钟' });
    await service.stopIntent('a', saved.id);
    await handleParkCarpoolConversation({ ...common, text: '确认发布' });
    expect(messages.at(-1)).toContain('已更新');
    expect((await h.store.getIntent('a'))?.status).toBe('paused');
  } finally { await h.close(); }
});


it('real UI can restart after stop and confirmation cannot carry forward another device’s stale fields', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fixed);
  const h = await sqliteHarness();
  const service = createParkCarpoolService({ store: h.store, now: () => fixed, createId: id => `intent-${id}`, mapProvider: {
    configured: true, searchPlaces: async () => [],
    planDrivingRoute: async (origin, destination) => ({ provider: 'synthetic-ui-fixture', distanceMeters: 8500, durationSeconds: 1200, polyline: [origin, destination] }),
  } });
  try {
    await service.publishIntent('a', publish);
    Object.assign(window.otto, {
      enterpriseParkCarpoolGet: () => service.getState('a'),
      enterpriseParkCarpoolRefresh: () => service.refreshMatches('a'),
      enterpriseParkCarpoolPublish: (value: Parameters<typeof service.publishIntent>[1]) => service.publishIntent('a', value),
      enterpriseParkCarpoolStop: (id: string) => service.stopIntent('a', id),
      enterpriseParkCarpoolConfirm: (id: string) => service.confirmIntent('a', id),
    });
    render(React.createElement(ParkCarpoolDialog, { open: true, onClose: () => undefined }));
    fireEvent.click(await screen.findByRole('button', { name: '停止寻找' }));
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }));
    await screen.findByText('已停止');
    fireEvent.click(screen.getByRole('button', { name: '发布并查找同路伙伴' }));
    await waitFor(async () => expect((await h.store.getIntent('a'))?.status).toBe('active'));
    await service.publishIntent('a', { ...publish, requestKey: 'second-device-edit', flexibleMinutes: 10 });
    fireEvent.click(screen.getByRole('button', { name: '刷新结果' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '仍在寻找' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '仍在寻找' }));
    await waitFor(() => expect((screen.getByLabelText('可接受前后') as HTMLSelectElement).value).toBe('10'));
    fireEvent.click(screen.getByRole('button', { name: '更新并重新匹配' }));
    await waitFor(async () => expect((await h.store.getIntent('a'))?.version).toBe(6));
    expect((await h.store.getIntent('a'))?.flexibleMinutes).toBe(10);
  } finally { await h.close(); vi.useRealTimers(); }
});


it('request center accepts a persisted request and renders the authoritative response', async () => {
  const h = await sqliteHarness();
  const service = createParkCarpoolService({store:h.store,now:()=>fixed,createId:id=>`intent-${id}`,mapProvider:{configured:true,searchPlaces:async()=>[],planDrivingRoute:async(a,b)=>({provider:'synthetic-ui',distanceMeters:8500,durationSeconds:1200,polyline:[a,b]})}});
  try {
    await service.publishIntent('a',publish);
    await service.publishIntent('b',publish);
    await service.executeWorkflow('a',{type:'request',kind:'text',targetIntentId:'intent-b',firstMessage:'可以聊聊同行吗？'});
    Object.assign(window.otto, { enterpriseParkCarpoolWorkflowGet:()=>service.getWorkflow('b'), enterpriseParkCarpoolWorkflowExecute:(command:Parameters<typeof service.executeWorkflow>[1])=>service.executeWorkflow('b',command), enterpriseParkCarpoolGet:()=>service.getState('b') });
    render(React.createElement(CarpoolRequestCenter));
    expect(await screen.findByText('可以聊聊同行吗？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'接受聊天'}));
    await waitFor(async()=>expect((await service.getWorkflow('b')).conversations).toHaveLength(1));
    expect((await service.getWorkflow('b')).myGroup).toBeNull();
    expect(await screen.findByText(/当前同行状态/)).toBeTruthy();
  } finally {await h.close();}
});
