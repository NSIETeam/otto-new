import { describe, expect, it, vi } from 'vitest';
import { EnterprisePolicyService } from './policyService.js';
import { MemoryPolicyStore } from './policyStore.js';
import type {
  OfficialPolicyDocument,
  PolicyActor,
  PolicyModel,
} from './contracts.js';

const actor: PolicyActor = {
  id: 'a',
  organizationId: 'o',
  organizationName: '深圳企业',
  isAdmin: true,
  active: true,
};
const profile = {
  registeredRegion: '广东省深圳市南山区',
  industry: '软件',
  mainBusiness: '软件研发',
  enterpriseType: '有限责任公司',
  establishedAt: '2020-01-01',
  qualifications: ['暂无'],
};
const document: OfficialPolicyDocument = {
  id: 'p1',
  title: '软件研发申报',
  url: 'https://www.gov.cn/p1',
  sourceId: 'national',
  sourceName: '国务院',
  issuer: '国务院',
  level: 'national',
  region: { country: 'CN' },
  categories: ['数字化转型'],
  deadline: '2026-10-01',
  fetchedAt: '2026-09-03T00:00:00Z',
  bodyText: '企业主营软件研发。营业收入不少于100万元。',
  contentHash: 'v1',
  version: 1,
  summary: '支持软件研发',
  supportText: '按原文规定',
  conditions: [
    {
      id: 'revenue',
      label: '收入要求',
      quote: '营业收入不少于100万元',
      factKeys: ['annualRevenueCny'],
      comparison: {
        field: 'annualRevenueCny',
        operator: 'gte',
        value: 1000000,
      },
    },
  ],
  conditionTree: { all: ['revenue'] },
  materials: [{ id: 'm1', label: '收入说明', quote: '营业收入不少于100万元' }],
  resources: [],
  attachments: [],
  sourceStatus: 'verified',
  interpretationStatus: 'ready',
  interpretationVersion: 3,
  exclusionsReviewed: true,
  exclusions: [],
};
function harness() {
  const store = new MemoryPolicyStore();
  const clock = { date: new Date('2026-09-03T00:00:00Z') };
  const model: PolicyModel = {
    name: 'test-model',
    extract: vi.fn(async (doc) => doc),
    analyze: vi.fn(async (doc) => ({
      relevant: true,
      summary: '请核验收入',
      refutation: { checked: true as const, concerns: [] },
      conditions: doc.conditions.map((item) => ({
        ...item,
        result: 'met' as const,
      })),
    })),
  };
  const service = new EnterprisePolicyService({
    store,
    model,
    sources: [],
    getActor: async (id) =>
      id === 'b'
        ? { ...actor, id: 'b' }
        : id === 'other'
          ? { ...actor, id: 'other', organizationId: 'other-org' }
          : id === 'member'
            ? { ...actor, id, isAdmin: false }
            : actor,
    now: () => clock.date,
  });
  return { store, model, service, clock };
}
async function enabled(h: ReturnType<typeof harness>) {
  await h.store.update('document:p1', () => document);
  await h.service.act('a', { action: 'profile', profile, consent: true });
  await h.service.act('a', {
    action: 'configure',
    enabled: true,
    consent: true,
  });
}
describe('enterprise policy workspace isolation and diagnostics', () => {
  it('does not let already interpreted closed policies starve later actionable recommendations', async () => {
    const h = harness();
    await enabled(h);
    for (let index = 0; index < 9; index++)
      await h.store.update(`document:closed-${index}`, () => ({
        ...document,
        id: `closed-${index}`,
        fetchedAt: '2026-09-03T01:00:00Z',
        deadline: '2026-09-02',
      }));
    const state = await h.service.act('a', { action: 'sync' });
    expect(state.assessments.map((item) => item.policyId)).toEqual(['p1']);
    expect(h.model.extract).not.toHaveBeenCalled();
    expect(h.model.analyze).toHaveBeenCalledTimes(1);
  });
  it('discards a pending analysis when the application window closes during the model call', async () => {
    const h = harness();
    await enabled(h);
    await h.store.update('document:p1', () => ({
      ...document,
      deadline: '2026-09-03',
    }));
    vi.mocked(h.model.analyze).mockImplementationOnce(async () => {
      h.clock.date = new Date('2026-09-04T00:00:00+08:00');
      return { relevant: true, summary: '', conditions: [] };
    });
    await expect(
      h.service.act('a', {
        action: 'diagnose',
        policyId: 'p1',
        consent: true,
      }),
    ).rejects.toThrow(/截止|受理/);
    expect((await h.service.state('a')).diagnoses).toEqual([]);
  });
  it('does not inherit unverified application dates or evergreen status from a legacy extraction', async () => {
    const h = harness();
    await enabled(h);
    await h.store.update('document:p1', () => ({
      ...document,
      interpretationVersion: 2,
      evergreen: true,
    }));
    const { deadline: _oldDeadline, ...newExtraction } = document;
    vi.mocked(h.model.extract).mockResolvedValueOnce(newExtraction);
    await expect(
      h.service.act('a', {
        action: 'diagnose',
        policyId: 'p1',
        consent: true,
      }),
    ).rejects.toThrow(/受理/);
    const current = (await h.service.state('a')).policies[0];
    expect(current.deadline).toBeUndefined();
    expect(current.evergreen).toBeUndefined();
    expect(h.model.analyze).not.toHaveBeenCalled();
  });
  it('does not revive a diagnosis deleted while its answer is being analyzed', async () => {
    const h = harness();
    await enabled(h);
    const initial = await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    const diagnosis = initial.diagnoses[0];
    let finish!: (result: Awaited<ReturnType<PolicyModel['analyze']>>) => void;
    vi.mocked(h.model.analyze).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.service.act('a', {
      action: 'answer',
      diagnosisId: diagnosis.id,
      revision: diagnosis.revision,
      field: 'annualRevenueCny',
      value: 1500000,
    });
    const rejected = expect(pending).rejects.toThrow(/更新/);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await h.service.act('a', {
      action: 'delete-diagnosis',
      diagnosisId: diagnosis.id,
    });
    finish({ relevant: true, summary: '', conditions: [] });
    await rejected;
    expect((await h.service.state('a')).diagnoses).toEqual([]);
  });
  it('expires recommendation badges and puts a refreshed diagnosis ahead of obsolete history', async () => {
    const h = harness();
    await enabled(h);
    await h.service.act('a', { action: 'sync' });
    expect((await h.service.state('a')).assessments).toHaveLength(1);
    await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    h.clock.date = new Date('2026-10-02T00:00:00Z');
    expect((await h.service.state('a')).assessments).toHaveLength(0);
    expect((await h.service.state('a')).diagnoses[0].stale).toBe(true);
    await h.store.update('document:p1', () => ({
      ...document,
      deadline: '2026-11-01',
    }));
    const refreshed = await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    expect(refreshed.diagnoses).toHaveLength(2);
    expect(refreshed.diagnoses[0].stale).toBe(false);
    expect(refreshed.diagnoses[1].stale).toBe(true);
  });
  it('short-circuits confirmed exclusions before paid analysis, honors an unknown exception and private boolean answers', async () => {
    const h = harness();
    await enabled(h);
    const quote = '失信企业不予支持，已修复信用的除外。';
    await h.store.update('document:p1', () => ({
      ...document,
      bodyText: document.bodyText + quote,
      exclusions: [
        {
          id: 'credit',
          label: '失信排除',
          quote,
          when: { field: 'blacklisted', operator: 'eq', value: true, quote },
          unless: { field: 'repaired', operator: 'eq', value: true, quote },
          question: '企业是否列入失信名单？',
        },
      ],
    }));
    let state = await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    expect(state.diagnoses[0].question?.field).toBe('blacklisted');
    expect(state.diagnoses[0].status).toBe('unknown');
    for (const [field, value] of [
      ['blacklisted', true],
      ['repaired', false],
    ] as const) {
      const d = state.diagnoses[0];
      state = await h.service.act('a', {
        action: 'answer',
        diagnosisId: d.id,
        revision: d.revision,
        field,
        value,
      });
    }
    expect(state.diagnoses[0]).toMatchObject({
      status: 'unlikely',
      group: 'all',
    });
    expect(h.model.analyze).not.toHaveBeenCalled();
    expect(state.usedAnalysesToday).toBe(0);
    expect((await h.service.state('b')).diagnoses).toEqual([]);
  });
  it('does not let a scoped exclusion veto a met alternative branch', async () => {
    const h = harness();
    await enabled(h);
    const quote = '营业收入不少于100万元。主营软件研发的企业也可申报。';
    await h.store.update('document:p1', () => ({
      ...document,
      bodyText: quote,
      conditions: [
        ...document.conditions,
        {
          id: 'business',
          label: '业务',
          quote: '主营软件研发的企业也可申报',
          factKeys: ['mainBusiness'],
        },
      ],
      conditionTree: { any: ['revenue', 'business'] },
      exclusions: [
        {
          id: 'no',
          label: '收入路线限制',
          quote,
          scopeConditionIds: ['revenue'],
          when: {
            field: 'annualRevenueCny',
            operator: 'lte',
            value: 1000000,
            quote,
          },
        },
      ],
    }));
    await h.service.act('a', {
      action: 'profile',
      profile: { annualRevenueCny: 5 },
      consent: true,
    });
    const state = await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    expect(state.diagnoses[0].status).toBe('likely_eligible');
    expect(state.diagnoses[0].question).toBeUndefined();
  });
  it('withholds an affirmative result on refutation, hides diagnostics/materials from members, and minimizes model input', async () => {
    const h = harness();
    await enabled(h);
    await h.service.act('a', {
      action: 'profile',
      profile: {
        annualRevenueCny: 2000000,
        rdExpenseCny: 99,
        notes: '私有敏感说明',
      },
      consent: true,
    });
    vi.mocked(h.model.analyze).mockImplementation(async (doc) => ({
      relevant: true,
      summary: '',
      conditions: doc.conditions.map((c) => ({ ...c, result: 'met' })),
      refutation: {
        checked: true,
        concerns: [
          { quote: '营业收入不少于100万元', note: '数据所属年度仍需核实' },
        ],
      },
    }));
    const state = await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    expect(state.diagnoses[0].status).toBe('unknown');
    const sent = vi.mocked(h.model.analyze).mock.calls[0][1];
    expect(sent.annualRevenueCny).toBe(2000000);
    expect(sent).not.toHaveProperty('notes');
    expect(sent).not.toHaveProperty('rdExpenseCny');
    await h.service.act('a', {
      action: 'material',
      policyId: 'p1',
      materialId: 'm1',
      materialStatus: 'ready',
    });
    expect(await h.service.state('member')).toMatchObject({
      assessments: [],
      diagnoses: [],
      materials: {},
      feedback: [],
    });
  });
  it('stores feedback idempotently under the account without rewriting rules, requires consent and rejects stale writes', async () => {
    const h = harness();
    await enabled(h);
    const input = {
      action: 'feedback' as const,
      policyId: 'p1',
      revision: 0,
      consent: true,
      feedback: {
        outcome: 'rejected' as const,
        reason: 'quota' as const,
        note: '名额不足',
      },
    };
    await expect(
      h.service.act('a', { ...input, consent: false }),
    ).rejects.toThrow(/确认/);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => h.service.act('a', input)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const state = await h.service.state('a');
    expect(state.feedback).toHaveLength(1);
    expect(state.feedback![0]).toMatchObject({
      revision: 1,
      reviewStatus: 'recorded',
      reason: 'quota',
    });
    expect((await h.service.state('b')).feedback).toEqual([]);
    expect((await h.service.state('other')).feedback).toEqual([]);
    expect(await h.store.get('document:p1')).toEqual(document);
    await h.service.act('a', {
      ...input,
      revision: 1,
      feedback: {
        outcome: 'dispute',
        reason: 'eligibility',
        note: '排除条款适用范围有疑问',
      },
    });
    expect((await h.service.state('a')).feedback![0].reviewStatus).toBe(
      'pending',
    );
    await h.service.act('a', {
      action: 'delete-feedback',
      policyId: 'p1',
      revision: 2,
      consent: true,
    });
    expect((await h.service.state('a')).feedback).toEqual([]);
    await expect(h.service.act('a', input)).rejects.toThrow(/已更新/);
    await h.service.act('a', {
      ...input,
      revision: (await h.service.state('a')).feedbackRevisions!.p1,
    });
    expect((await h.service.state('a')).feedback).toHaveLength(1);
  });
  it('ignores injected feedback ownership/version fields and forbids member or foreign-account deletion', async () => {
    const h = harness();
    await enabled(h);
    const input = {
      action: 'feedback' as const,
      policyId: 'p1',
      consent: true,
      revision: 0,
      feedback: {
        outcome: 'approved' as const,
        reason: 'none' as const,
        note: '自行记录',
        policyId: 'forged',
        policyVersion: 999,
        accountId: 'other',
        answers: { secret: 'do not copy' },
      },
    };
    await expect(h.service.act('member', input)).rejects.toThrow(/管理员/);
    const result = await h.service.act('a', input);
    expect(result.feedback![0]).toMatchObject({
      policyId: 'p1',
      policyVersion: 1,
    });
    expect(result.feedback![0]).not.toHaveProperty('answers');
    await expect(
      h.service.act('b', {
        action: 'delete-feedback',
        policyId: 'p1',
        revision: 1,
        consent: true,
      }),
    ).rejects.toThrow();
  });
  it('marks old diagnoses stale on a rule-only change and refuses withdrawn/undated policies', async () => {
    const h = harness();
    await enabled(h);
    await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    await h.store.update('document:p1', () => ({
      ...document,
      governance: {
        status: 'revoked',
        quote: '本文件现予废止',
        referenceUrl: document.url,
      },
    }));
    expect((await h.service.state('a')).diagnoses[0].stale).toBe(true);
    await expect(
      h.service.act('a', { action: 'diagnose', policyId: 'p1', consent: true }),
    ).rejects.toThrow(/截止|废止|受理/);
    await h.store.update('document:p1', () => ({
      ...document,
      deadline: undefined,
    }));
    await expect(
      h.service.act('a', { action: 'diagnose', policyId: 'p1', consent: true }),
    ).rejects.toThrow(/核验|受理/);
  });
  it('bounds 100 parallel diagnosis submissions to one model invocation', async () => {
    const h = harness();
    await enabled(h);
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () =>
        h.service.act('a', {
          action: 'diagnose',
          policyId: 'p1',
          consent: true,
        }),
      ),
    );
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(h.model.analyze).toHaveBeenCalledTimes(1);
  });
  it('deduplicates old-rule extraction across accounts and does not bless legacy rules', async () => {
    const h = harness();
    await enabled(h);
    await h.store.update('document:p1', () => ({
      ...document,
      interpretationVersion: 2,
      exclusionsReviewed: undefined,
    }));
    vi.mocked(h.model.extract).mockImplementation(async () => document);
    await Promise.allSettled(
      ['a', 'b'].map((id) =>
        h.service.act(id, {
          action: 'diagnose',
          policyId: 'p1',
          consent: true,
        }),
      ),
    );
    expect(h.model.extract).toHaveBeenCalledTimes(1);
    expect((await h.service.state('a')).policies[0].interpretationVersion).toBe(
      3,
    );
  });
  it('preserves original public text snapshots on a content update', async () => {
    const h = harness();
    const source = {
      id: 'national',
      name: '官方测试来源',
      listUrl: 'https://www.gov.cn/list/',
      allowedHosts: ['www.gov.cn'],
      level: 'national' as const,
      region: { country: 'CN' as const },
    };
    let body = '第一版正文：企业可以申请项目支持，具体按照申报通知执行。';
    const service = new EnterprisePolicyService({
      store: h.store,
      sources: [source],
      getActor: async () => actor,
      fetchImpl: async (url) =>
        new Response(
          String(url).endsWith('/list/')
            ? '<a href="/policy1">企业项目支持申报通知</a>'
            : `<h1>企业项目支持申报通知</h1><article>${body}</article>`,
        ),
    });
    await service.collect();
    const old = (await service.state('a')).policies[0];
    body = '第二版正文：本文件自2026年9月1日起废止，不再受理新的申报。';
    await service.collect();
    const current = (await service.state('a')).policies[0];
    expect(current.version).toBe(old.version + 1);
    expect(current.contentHash).not.toBe(old.contentHash);
    const history = await h.store.list<{ bodyText: string }>(
      `snapshot:${old.id}:`,
    );
    expect(history).toHaveLength(2);
    expect(
      history.some((row) => row.value.bodyText.startsWith('第一版正文')),
    ).toBe(true);
  });
  it('deduplicates concurrent recommendation refreshes for the same enterprise', async () => {
    const h = harness();
    await enabled(h);
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => h.service.act('a', { action: 'sync' })),
    );
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(h.model.analyze).toHaveBeenCalledTimes(1);
  });
  it('limits source warnings to the enterprise region while preserving partial results', async () => {
    const h = harness();
    const sources = [
      {
        id: 'national',
        name: '国家政策',
        listUrl: 'https://www.gov.cn/list/',
        allowedHosts: ['www.gov.cn'],
        level: 'national' as const,
        region: { country: 'CN' as const },
      },
      {
        id: 'beijing',
        name: '北京市政策',
        listUrl: 'https://www.beijing.gov.cn/list/',
        allowedHosts: ['www.beijing.gov.cn'],
        level: 'city' as const,
        region: { country: 'CN' as const, city: '北京市' },
      },
    ];
    const service = new EnterprisePolicyService({
      store: h.store,
      sources,
      getActor: async () => actor,
      fetchImpl: async (url) => {
        if (String(url).includes('beijing') || String(url).endsWith('/gone'))
          return new Response('not found', { status: 404 });
        return new Response(
          String(url).endsWith('/list/')
            ? '<a href="/gone">暂时失效的申报通知</a><a href="/valid">有效的绿色融资申报通知</a>'
            : '<h1>有效的绿色融资申报通知</h1><article>本市符合要求的企业可以申请绿色融资服务。</article>',
        );
      },
    });
    await service.act('a', { action: 'profile', profile, consent: true });
    await service.collect();
    const state = await service.state('a');
    expect(state.policies).toHaveLength(1);
    expect(state.lastError).toContain('国家政策');
    expect(state.lastError).not.toContain('北京市政策');
    expect(state.policies[0].sourceStatus).toBe('verified');
  });
  it('cancels a pending model result if the enterprise disables the feature', async () => {
    const h = harness();
    await enabled(h);
    let finish!: (result: Awaited<ReturnType<PolicyModel['analyze']>>) => void;
    vi.mocked(h.model.analyze).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await h.service.act('a', { action: 'configure', enabled: false });
    finish({ relevant: true, summary: 'bad', conditions: [] });
    await expect(pending).rejects.toThrow(/取消/);
    expect((await h.service.state('a')).diagnoses).toEqual([]);
  });
  it('fails closed for unavailable sources, missing attachments and cross-city policies', async () => {
    const h = harness();
    await enabled(h);
    for (const patch of [
      { sourceStatus: 'unavailable' as const },
      {
        attachments: [
          { label: '申报要求', url: 'https://www.gov.cn/a.pdf', parsed: false },
        ],
      },
      {
        level: 'city' as const,
        region: { country: 'CN' as const, city: '北京市' },
      },
    ]) {
      await h.store.update('document:p1', () => ({ ...document, ...patch }));
      await expect(
        h.service.act('a', {
          action: 'diagnose',
          policyId: 'p1',
          consent: true,
        }),
      ).rejects.toThrow();
    }
    expect(h.model.analyze).not.toHaveBeenCalled();
  });
  it('allows every active enterprise member to browse without a park entitlement', async () => {
    const h = harness();
    await h.store.update('document:p1', () => document);
    const state = await h.service.state('member');
    expect(state.policies).toHaveLength(1);
    expect(state.canManage).toBe(false);
    await expect(
      h.service.act('member', {
        action: 'configure',
        enabled: true,
        consent: true,
      }),
    ).rejects.toThrow(/管理员/);
    expect(h.model.analyze).not.toHaveBeenCalled();
  });
  it('requires opt-in and explicit consent before diagnosis', async () => {
    const h = harness();
    await h.store.update('document:p1', () => document);
    await expect(
      h.service.act('a', { action: 'diagnose', policyId: 'p1', consent: true }),
    ).rejects.toThrow(/开启/);
    await enabled(h);
    await expect(
      h.service.act('a', { action: 'diagnose', policyId: 'p1' }),
    ).rejects.toThrow(/同意/);
  });
  it('persists single-use answers only in the account diagnosis and enforces arithmetic', async () => {
    const h = harness();
    await enabled(h);
    const started = await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    const diagnosis = started.diagnoses[0];
    expect(diagnosis.status).toBe('unknown');
    const answered = await h.service.act('a', {
      action: 'answer',
      diagnosisId: diagnosis.id,
      revision: diagnosis.revision,
      field: 'annualRevenueCny',
      value: 500000,
    });
    expect(answered.diagnoses[0].status).toBe('has_gaps');
    expect(answered.profile.annualRevenueCny).toBeUndefined();
    expect((await h.service.state('b')).diagnoses).toEqual([]);
    await expect(
      h.service.act('b', {
        action: 'answer',
        diagnosisId: diagnosis.id,
        field: 'annualRevenueCny',
        value: 3000000,
        revision: 1,
      }),
    ).rejects.toThrow(/诊断/);
    expect((await h.service.state('other')).enabled).toBe(false);
  });
  it('invalidates old facts, isolates concurrent answers and shares only explicit enterprise updates', async () => {
    const h = harness();
    await enabled(h);
    const state = await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    const diagnosis = state.diagnoses[0];
    await h.service.act('a', {
      action: 'answer',
      diagnosisId: diagnosis.id,
      revision: diagnosis.revision,
      field: 'annualRevenueCny',
      value: null,
    });
    await expect(
      h.service.act('a', {
        action: 'answer',
        diagnosisId: diagnosis.id,
        revision: diagnosis.revision,
        field: 'annualRevenueCny',
        value: 2000000,
      }),
    ).rejects.toThrow(/更新/);
    await h.service.act('a', {
      action: 'profile',
      profile: { industry: '食品加工' },
      consent: true,
    });
    expect((await h.service.state('a')).diagnoses[0].stale).toBe(true);
  });
  it('reuses an unchanged diagnosis and does not call models after service is disabled', async () => {
    const h = harness();
    await enabled(h);
    await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    expect(h.model.analyze).toHaveBeenCalledTimes(1);
    await h.service.act('a', { action: 'configure', enabled: false });
    await expect(
      h.service.act('a', { action: 'diagnose', policyId: 'p1', consent: true }),
    ).rejects.toThrow(/开启/);
  });
  it('does not share profile changes from an answer rejected by the concurrency lock', async () => {
    const h = harness();
    await enabled(h);
    const initial = await h.service.act('a', {
      action: 'diagnose',
      policyId: 'p1',
      consent: true,
    });
    const diagnosis = initial.diagnoses[0];
    let finish!: (result: Awaited<ReturnType<PolicyModel['analyze']>>) => void;
    vi.mocked(h.model.analyze).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.service.act('a', {
      action: 'answer',
      diagnosisId: diagnosis.id,
      revision: diagnosis.revision,
      field: 'annualRevenueCny',
      value: 1500000,
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(
      h.service.act('a', {
        action: 'answer',
        diagnosisId: diagnosis.id,
        revision: diagnosis.revision,
        field: 'annualRevenueCny',
        value: 9000000,
        saveToEnterprise: true,
        consent: true,
      }),
    ).rejects.toThrow(/正在更新/);
    expect(
      (await h.service.state('a')).profile.annualRevenueCny,
    ).toBeUndefined();
    finish({ relevant: true, summary: '', conditions: [] });
    await first;
  });
  it('requires a valid material id and keeps manual readiness scoped to the enterprise', async () => {
    const h = harness();
    await enabled(h);
    await expect(
      h.service.act('a', {
        action: 'material',
        policyId: 'p1',
        materialId: 'fake',
        materialStatus: 'ready',
      }),
    ).rejects.toThrow(/材料/);
    await h.service.act('a', {
      action: 'material',
      policyId: 'p1',
      materialId: 'm1',
      materialStatus: 'ready',
    });
    expect(
      Object.values((await h.service.state('b')).materials)[0].status,
    ).toBe('ready');
    expect((await h.service.state('other')).materials).toEqual({});
  });
});
