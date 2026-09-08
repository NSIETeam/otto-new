/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ClaimEvidenceLedger } from './claimEvidence.js';

const source = (
  text = 'Acme revenue FY2025 USD 42 billion.',
  uri = 'https://example.com/report',
) => ({
  uri,
  retrievedAt: '2026-09-08T00:00:00.000Z',
  text,
  sha256: createHash('sha256').update(text).digest('hex'),
  truncated: false,
});
const draft =
  '该页记载：“Acme revenue FY2025 USD 42 billion.” [来源](https://example.com/report)';
const binding = () => ({
  text: draft,
  kind: 'quotation',
  evidence: [{ sourceId: 'fetch:0', start: 0, end: source().text.length }],
});

describe('native claim evidence, not successful URL discovery', () => {
  it('accepts linked verbatim quotations without requiring a fixed reporting prefix', () => {
    const ledger = new ClaimEvidenceLedger();
    ledger.observe('fetch', [source()]);
    const text = `“${source().text}” [报告](https://example.com/report)`;
    expect(
      ledger
        .review(
          { requestRevision: 1, draft: text, claims: [{ ...binding(), text }] },
          1,
        )
        .checks.every((c) => c.status === 'passed'),
    ).toBe(true);
    for (const bad of [
      text.replace('42', '420'),
      text.replace(/ \[报告\].+$/u, ''),
      '这是真的。' + text,
    ]) {
      expect(
        ledger
          .review(
            {
              requestRevision: 1,
              draft: bad,
              claims: [{ ...binding(), text: bad }],
            },
            1,
          )
          .checks.some((c) => c.status !== 'passed'),
      ).toBe(true);
    }
  });
  it('allows one natural uncertainty sentence instead of mandatory repeated boilerplate', () => {
    const ledger = new ClaimEvidenceLedger();
    const text =
      '今年的营收还无法确认，也无法核实这些数据是否最新，未能验证该网站的发布者身份。';
    const result = ledger.review(
      {
        requestRevision: 1,
        draft: text,
        claims: [{ text, kind: 'uncertain', evidence: [] }],
      },
      1,
      '查找今年最新官方营收',
    );
    expect(result.checks.every((c) => c.status === 'passed')).toBe(true);
    const falseClaim = '今年的营收还无法确认，但已经证实它一定增长。';
    expect(
      ledger
        .review(
          {
            requestRevision: 1,
            draft: falseClaim,
            claims: [{ text: falseClaim, kind: 'uncertain', evidence: [] }],
          },
          1,
        )
        .checks.some((c) => c.status === 'failed'),
    ).toBe(true);
  });
  it('allows a single visible uncertainty marker for an inference but not invented figures', () => {
    const ledger = new ClaimEvidenceLedger();
    ledger.observe('fetch', [source()]);
    const text = '营收可能支持后续投入。 [来源](https://example.com/report)';
    expect(
      ledger
        .review(
          {
            requestRevision: 1,
            draft: text,
            claims: [{ ...binding(), text, kind: 'inference' }],
          },
          1,
        )
        .checks.every((c) => c.status === 'passed'),
    ).toBe(true);
    const bad = text.replace('可能支持后续投入', '可能达到999亿美元');
    expect(
      ledger
        .review(
          {
            requestRevision: 1,
            draft: bad,
            claims: [{ ...binding(), text: bad, kind: 'inference' }],
          },
          1,
        )
        .checks.some((c) => c.status === 'failed'),
    ).toBe(true);
  });
  it('rejects a URL-only or forged-hash source', () => {
    const ledger = new ClaimEvidenceLedger();
    expect(
      ledger.observe('fetch', [{ ...source(), sha256: '0'.repeat(64) }]),
    ).toBe(false);
    expect(
      ledger
        .review({ requestRevision: 1, draft, claims: [binding()] }, 1)
        .checks.some((c) => c.status !== 'passed'),
    ).toBe(true);
  });
  it('binds exact text offsets and current draft without asserting publisher authority', () => {
    const ledger = new ClaimEvidenceLedger();
    ledger.observe('fetch', [source()]);
    const result = ledger.review(
      { requestRevision: 1, draft, claims: [binding()] },
      1,
    );
    expect(result.checks.every((c) => c.status === 'passed')).toBe(true);
    expect(result.claims[0].status).toBe('attributed');
    expect(result.sources[0].authority).toBe('unverified');
    expect(
      ledger
        .checks(draft + '\nProfit is 100.', 1)
        .some((c) => c.status !== 'passed'),
    ).toBe(true);
    expect(ledger.checks(draft, 2).some((c) => c.status !== 'passed')).toBe(
      true,
    );
  });
  it.each(['43', '2026', 'EUR'])(
    'rejects invented or changed number/period/unit %s',
    (change) => {
      const ledger = new ClaimEvidenceLedger();
      ledger.observe('fetch', [source()]);
      const altered = draft.replace(
        change === '43' ? '42' : change === '2026' ? '2025' : 'USD',
        change,
      );
      const result = ledger.review(
        {
          requestRevision: 1,
          draft: altered,
          claims: [{ ...binding(), text: altered }],
        },
        1,
      );
      expect(result.checks.some((c) => c.status !== 'passed')).toBe(true);
    },
  );
  it('does not let one registered claim cover another paragraph', () => {
    const ledger = new ClaimEvidenceLedger();
    ledger.observe('fetch', [source()]);
    const result = ledger.review(
      {
        requestRevision: 1,
        draft: draft + '\n未来一定增长。',
        claims: [binding()],
      },
      1,
    );
    expect(result.checks.find((c) => c.id === 'claims:coverage')?.status).toBe(
      'not_run',
    );
  });
  it('keeps uncertain findings visible but does not certify them', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = '尚未证实今年营收，缺少公开原文，不能据此下结论。';
    const result = ledger.review(
      {
        requestRevision: 1,
        draft: text,
        claims: [{ text, kind: 'uncertain', evidence: [] }],
      },
      1,
    );
    expect(result.claims[0].status).toBe('uncertain');
    expect(result.checks.every((c) => c.status === 'passed')).toBe(true);
  });
  it('requires explicit uncertainty for conflicting values of the same scoped metric', () => {
    const ledger = new ClaimEvidenceLedger();
    ledger.observe('fetch', [
      source(),
      source(
        'Acme revenue FY2025 USD 45 billion.',
        'https://other.example/report',
      ),
    ]);
    const text = 'Acme revenue FY2025 USD 为42或45 billion。';
    const claim = {
      text,
      kind: 'inference',
      facet: {
        subject: 'Acme',
        metric: 'revenue',
        period: 'FY2025',
        unit: 'USD',
      },
      evidence: [
        {
          sourceId: 'fetch:0',
          start: 0,
          end: source().text.length,
          value: '42',
        },
        {
          sourceId: 'fetch:1',
          start: 0,
          end: source().text.length,
          value: '45',
        },
      ],
    };
    const result = ledger.review(
      { requestRevision: 1, draft: text, claims: [claim] },
      1,
    );
    expect(result.checks.some((c) => c.status === 'failed')).toBe(true);
  });
  it('invalidates a checked answer when additional evidence arrives', () => {
    const ledger = new ClaimEvidenceLedger();
    ledger.observe('fetch', [source()]);
    ledger.review({ requestRevision: 1, draft, claims: [binding()] }, 1);
    ledger.observe('new', [source('Correction: revenue unknown.')]);
    expect(ledger.checks(draft, 1).some((c) => c.status !== 'passed')).toBe(
      true,
    );
  });
  it('fails closed on oversized input and never truncates claim inventory to pass', () => {
    const ledger = new ClaimEvidenceLedger();
    expect(() =>
      ledger.review(
        { requestRevision: 1, draft: 'x'.repeat(33000), claims: [] },
        1,
      ),
    ).toThrow();
  });
  it('does not equate retrieval time with publication period or publisher authority', () => {
    const ledger = new ClaimEvidenceLedger();
    ledger.observe('fetch', [source()]);
    const result = ledger.review(
      { requestRevision: 1, draft, claims: [binding()] },
      1,
      '核实2026年最新官方营收',
    );
    expect(
      result.checks.filter((c) => c.status !== 'passed').map((c) => c.id),
    ).toEqual(
      expect.arrayContaining([
        'claims:requested-period',
        'claims:freshness',
        'claims:authority',
      ]),
    );
  });
  it('checks conflicting retrieved statements even if the model omits the unfavorable source', () => {
    const ledger = new ClaimEvidenceLedger();
    ledger.observe('fetch', [
      source(),
      source(
        'Acme revenue FY2025 USD 45 billion.',
        'https://other.example/report',
      ),
    ]);
    const result = ledger.review(
      { requestRevision: 1, draft, claims: [binding()] },
      1,
    );
    expect(result.checks.some((c) => c.status === 'failed')).toBe(true);
  });
  it('flags directly contradictory affirmative/negative source statements', () => {
    const ledger = new ClaimEvidenceLedger();
    ledger.observe('fetch', [
      source('该产品支持离线。'),
      source('该产品不支持离线。', 'https://other.example'),
    ]);
    const text =
      '该页记载：“该产品支持离线。” [来源](https://example.com/report)';
    const result = ledger.review(
      {
        requestRevision: 1,
        draft: text,
        claims: [
          {
            text,
            kind: 'quotation',
            evidence: [{ sourceId: 'fetch:0', start: 0, end: 9 }],
          },
        ],
      },
      1,
    );
    expect(result.checks.some((c) => c.status === 'failed')).toBe(true);
  });
});
