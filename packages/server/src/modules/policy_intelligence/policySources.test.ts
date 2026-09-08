import { describe, expect, it, vi } from 'vitest';
import {
  validatePolicySources,
  collectPolicySource,
  policyRecheckCandidates,
  loadPolicySources,
} from './policySources.js';
import type { OfficialPolicyDocument } from './contracts.js';
const source = {
  id: 'sz',
  name: '深圳市',
  listUrl: 'https://www.sz.gov.cn/policies/',
  allowedHosts: ['www.sz.gov.cn'],
  level: 'city' as const,
  region: { country: 'CN' as const, city: '深圳市' },
};
describe('policy source registry and collector', () => {
  it('does not hide off-allowlist attachments when deciding the original is complete', async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          String(url).endsWith('/policies/')
            ? '<a href="/notice.html">科技企业项目申报通知</a>'
            : '<h1>科技企业项目申报通知</h1><article>完整条件及材料要求请查看附件。<a href="https://evil.test/conditions.docx">附件：条件.docx</a></article>',
        ),
    );
    const [doc] = await collectPolicySource(
      source,
      fetcher,
      AbortSignal.timeout(5000),
    );
    expect(doc.attachments).toHaveLength(1);
    expect(doc.attachments[0].parsed).toBe(false);
    expect(doc.attachments[0].reason).toContain('白名单');
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes('evil.test')),
    ).toBe(false);
  });
  it('registers all 31 mainland provincial government entry points without claiming successful ingestion', () => {
    const sources = loadPolicySources();
    expect(
      new Set(
        sources
          .filter((s) => s.id.startsWith('province-'))
          .map((s) => s.region.province),
      ).size,
    ).toBe(31);
    expect(
      sources
        .filter((s) => s.id.startsWith('province-'))
        .every(
          (s) => s.discovery === 'portal' && s.listUrl.startsWith('https://'),
        ),
    ).toBe(true);
  });
  it('discovers bounded policy lists from a provincial portal without crawling news or other hosts', async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          String(url).endsWith('/portal/')
            ? '<nav><a href="/policy/">政策文件</a></nav><a href="https://evil.test/">政策文件库</a><a href="/news">领导活动</a>'
            : String(url).endsWith('/policy/')
              ? '<a href="/doc.html">关于支持企业科技创新的通知</a>'
              : '<h1>关于支持企业科技创新的通知</h1><article>支持科技企业创新，具体要求见本次申报通知。</article>',
        ),
    );
    const docs = await collectPolicySource(
      {
        ...source,
        listUrl: 'https://www.sz.gov.cn/portal/',
        discovery: 'portal',
      },
      fetcher,
      AbortSignal.timeout(5000),
    );
    expect(docs).toHaveLength(1);
    expect(
      fetcher.mock.calls.some(([url]) => /evil|news/u.test(String(url))),
    ).toBe(false);
  });
  it('rechecks bounded historical and near-deadline pages without trusting arbitrary URLs', async () => {
    const now = new Date('2026-09-03T00:00:00Z');
    const old = {
      id: 'old',
      sourceId: source.id,
      url: 'https://www.sz.gov.cn/old.html',
      title: '旧批次申报公告',
      fetchedAt: '2026-08-01T00:00:00Z',
    } as OfficialPolicyDocument;
    const recent = {
      ...old,
      id: 'recent',
      fetchedAt: '2026-09-02T10:00:00Z',
      deadline: '2026-09-05',
    };
    expect(policyRecheckCandidates([recent], now)).toHaveLength(1);
    expect(
      policyRecheckCandidates([{ ...recent, deadline: undefined }], now),
    ).toHaveLength(0);
    expect(
      policyRecheckCandidates(
        Array.from({ length: 20 }, (_, i) => ({ ...old, id: String(i) })),
        now,
        new Set(['19']),
      )[0].id,
    ).toBe('19');
    expect(policyRecheckCandidates(Array(20).fill(old), now)).toHaveLength(4);
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          String(url).endsWith('/policies/')
            ? '<a href="/new.html">最新企业项目申报公告</a>'
            : '<h1>企业项目申报公告</h1><article>本批次支持企业创新项目申报，请核验申报材料。</article>',
        ),
    );
    const docs = await collectPolicySource(
      source,
      fetcher,
      new AbortController().signal,
      now,
      undefined,
      [old, { ...old, url: 'https://127.0.0.1/private' }],
    );
    expect(docs.map((doc) => doc.url)).toContain(old.url);
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes('127.0.0.1')),
    ).toBe(false);
  });
  it('rejects tenant supplied or non-government destinations', () => {
    expect(() =>
      validatePolicySources([
        { ...source, listUrl: 'http://127.0.0.1/private' },
      ]),
    ).toThrow();
    expect(() =>
      validatePolicySources([
        { ...source, allowedHosts: ['gov.cn.evil.test'] },
      ]),
    ).toThrow();
    expect(() =>
      validatePolicySources([
        {
          ...source,
          level: 'district',
          region: { country: 'CN', district: '朝阳区' },
        },
      ]),
    ).toThrow();
  });
  it('does not filter discovery to the old five policy types', async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          String(url).endsWith('/policies/')
            ? '<a href="/policies/green.html">绿色制造企业融资支持办法</a><a href="https://evil.test/申报">坏政策</a>'
            : '<html><nav>菜单</nav><h1>绿色制造企业融资支持办法</h1><article>企业可申请绿色制造融资支持。具体以通知为准。</article></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
    );
    const docs = await collectPolicySource(
      source,
      fetcher,
      new AbortController().signal,
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].region.city).toBe('深圳市');
    expect(docs[0].deadline).toBeUndefined();
    expect(docs[0].interpretationStatus).toBe('pending');
    expect(docs[0].bodyText).not.toContain('菜单');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
  it('rejects oversized responses before reading content', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('bad', {
          headers: {
            'content-length': '999999999',
            'content-type': 'text/html',
          },
        }),
    );
    await expect(
      collectPolicySource(source, fetcher, new AbortController().signal),
    ).rejects.toThrow(/大小/);
  });
  it('retains valid policies and reports broken detail links separately', async () => {
    const failures = vi.fn();
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/gone.html')
        ? new Response('gone', { status: 404 })
        : new Response(
            String(url).endsWith('/policies/')
              ? '<a href="/gone.html">失效的企业政策申报通知</a><a href="/valid.html">有效的绿色融资申报通知</a>'
              : '<h1>有效的绿色融资申报通知</h1><article>本市符合要求的企业可以申请绿色融资服务。</article>',
          ),
    );
    const docs = await collectPolicySource(
      source,
      fetcher,
      new AbortController().signal,
      new Date(),
      failures,
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('有效的绿色融资申报通知');
    expect(failures).toHaveBeenCalledWith('https://www.sz.gov.cn/gone.html');
  });
  it('does not swallow shutdown cancellation as a partial source failure', async () => {
    const controller = new AbortController();
    const failures = vi.fn();
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).endsWith('/policies/')) {
        controller.abort();
        throw new Error('aborted');
      }
      return new Response('<a href="/valid.html">绿色融资政策申报通知</a>');
    });
    await expect(
      collectPolicySource(
        source,
        fetcher,
        controller.signal,
        new Date(),
        failures,
      ),
    ).rejects.toThrow();
    expect(failures).not.toHaveBeenCalled();
  });
});
