/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ClaimEvidenceLedger } from './claimEvidence.js';
const a = 'https://example.com/a';
const b = 'https://example.com/b';
const receipt = (text: string, uri = a) => ({
  text,
  uri,
  sha256: createHash('sha256').update(text).digest('hex'),
  retrievedAt: new Date().toISOString(),
  truncated: false,
});
const anchor = (text: string, sourceId = 'fetch:0', value?: string) => ({
  sourceId,
  start: 0,
  end: text.length,
  ...(value ? { value } : {}),
});
const review = (
  ledger: ClaimEvidenceLedger,
  claims: unknown[],
  draft: string,
  request = '',
) => ledger.review({ requestRevision: 1, claims, draft }, 1, request);
const passes = (result: ReturnType<typeof review>) =>
  result.checks.every((c) => c.status === 'passed');

describe('phase 5 precise evidence coverage', () => {
  it('does not silently change scale in a numerical inference even with copied facet metadata', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Acme revenue FY2025 USD 42 billion.';
    ledger.observe('fetch', [receipt(text)]);
    const draft = `Acme revenue FY2025 USD 42 million，可能持续。 [来源](${a})`;
    expect(
      passes(
        review(
          ledger,
          [
            {
              text: draft,
              kind: 'inference',
              facet: {
                subject: 'Acme',
                metric: 'revenue',
                period: 'FY2025',
                unit: 'USD',
              },
              evidence: [anchor(text, 'fetch:0', '42')],
            },
          ],
          draft,
        ),
      ),
    ).toBe(false);
  });
  it('keeps genuinely signed decimal evidence usable', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Acme growth FY2025 -12.5%.';
    ledger.observe('fetch', [receipt(text)]);
    const draft = `Acme growth FY2025 -12.5%，可能持续。 [来源](${a})`;
    expect(
      passes(
        review(
          ledger,
          [
            {
              text: draft,
              kind: 'inference',
              facet: {
                subject: 'Acme',
                metric: 'growth',
                period: 'FY2025',
                unit: '%',
              },
              evidence: [anchor(text, 'fetch:0', '-12.5%')],
            },
          ],
          draft,
        ),
      ),
    ).toBe(true);
  });
  it('requires discovered conflicting sources to be visible, but permits honest conflicting findings', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Acme revenue FY2025 USD 42 billion.';
    const other = 'FY2025: Acme reported revenue of USD 45 billion.';
    ledger.observe('fetch', [receipt(text), receipt(other, b)]);
    const draft = `Acme revenue FY2025 USD 数据存在冲突，暂不能确认。 [来源](${a})`;
    const claim = {
      text: draft,
      kind: 'uncertain',
      facet: {
        subject: 'Acme',
        metric: 'revenue',
        period: 'FY2025',
        unit: 'USD',
      },
      evidence: [anchor(text, 'fetch:0', '42')],
    };
    expect(passes(review(ledger, [claim], draft))).toBe(false);
    const complete = `${draft} [来源](${b})`;
    expect(
      passes(review(ledger, [{ ...claim, text: complete }], complete)),
    ).toBe(true);
  });
  it('does not join a subject and value from separate sentences or certify an ambiguous metric passage', () => {
    for (const text of [
      'Acme revenue FY2025 USD is reported elsewhere. OtherCorp revenue FY2025 USD 42 billion.',
      'Acme revenue FY2025 USD 42 billion and profit USD 7 billion.',
    ]) {
      const ledger = new ClaimEvidenceLedger();
      ledger.observe('fetch', [receipt(text)]);
      const draft = `Acme revenue FY2025 USD 42 billion，可能持续。 [来源](${a})`;
      expect(
        passes(
          review(
            ledger,
            [
              {
                text: draft,
                kind: 'inference',
                facet: {
                  subject: 'Acme',
                  metric: 'revenue',
                  period: 'FY2025',
                  unit: 'USD',
                },
                evidence: [anchor(text, 'fetch:0', '42')],
              },
            ],
            draft,
          ),
        ),
      ).toBe(false);
    }
  });
  it('does not clear integrity failures with an unrelated valid source, and removes replaced receipt pages', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Service available.';
    const other = 'Other page.';
    ledger.observe('fetch', [receipt(text), receipt(other, b)]);
    const draft = `“${other}” [来源](${b})`;
    const claim = {
      text: draft,
      kind: 'quotation',
      evidence: [anchor(other, 'fetch:1')],
    };
    expect(passes(review(ledger, [claim], draft))).toBe(true);
    ledger.observe('bad', [{ ...receipt(text), sha256: 'invalid' }]);
    ledger.observe('good', [receipt(text)]);
    expect(passes(review(ledger, [claim], draft))).toBe(false);
    ledger.observe('bad', [receipt(text)]);
    ledger.observe('fetch', [receipt(text)]);
    expect(passes(review(ledger, [claim], draft))).toBe(false);
  });
  it('can explicitly report a missing requested period without inventing its figures', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Acme FY2025 revenue 42.';
    ledger.observe('fetch', [receipt(text)]);
    const quote = `“${text}” [来源](${a})`;
    const unknown = '2026年数据证据不足，暂不能确认。';
    expect(
      passes(
        review(
          ledger,
          [
            { text: quote, kind: 'quotation', evidence: [anchor(text)] },
            { text: unknown, kind: 'uncertain', evidence: [] },
          ],
          `${quote}\n${unknown}`,
          '比较2025和2026的营收',
        ),
      ),
    ).toBe(true);
  });
  it('links a quotation to the source containing that quotation, not any supplied anchor', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Service available.';
    const other = 'Other page.';
    ledger.observe('fetch', [receipt(text), receipt(other, b)]);
    const draft = `“${text}” [来源](${b})`;
    const result = review(
      ledger,
      [
        {
          text: draft,
          kind: 'quotation',
          evidence: [anchor(text), anchor(other, 'fetch:1')],
        },
      ],
      draft,
    );
    expect(passes(result)).toBe(false);
    const correct = draft.replace(b, a);
    expect(
      passes(
        review(
          ledger,
          [{ text: correct, kind: 'quotation', evidence: [anchor(text)] }],
          correct,
        ),
      ),
    ).toBe(true);
  });
  it('does not hide new factual assertions in clickable citation labels', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Acme revenue FY2025 USD 42 billion.';
    ledger.observe('fetch', [receipt(text)]);
    const draft = `“${text}” [营收999亿美元已证实](${a})`;
    expect(
      passes(
        review(
          ledger,
          [{ text: draft, kind: 'quotation', evidence: [anchor(text)] }],
          draft,
        ),
      ),
    ).toBe(false);
  });
  it('invalidates a passing review when receipt integrity is lost; a corrected receipt can recover', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Service available.';
    const draft = `“${text}” [来源](${a})`;
    const claims = [
      { text: draft, kind: 'quotation', evidence: [anchor(text)] },
    ];
    ledger.observe('fetch', [receipt(text)]);
    expect(passes(review(ledger, claims, draft))).toBe(true);
    expect(
      ledger.observe('fetch', [{ ...receipt(text), sha256: '0'.repeat(64) }]),
    ).toBe(false);
    expect(ledger.checks(draft, 1).some((c) => c.status !== 'passed')).toBe(
      true,
    );
    expect(passes(review(ledger, claims, draft))).toBe(false);
    ledger.observe('fetch', [receipt(text)]);
    expect(passes(review(ledger, claims, draft))).toBe(true);
  });
  it('does not reuse earlier approval after source capacity was exceeded', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Service available.';
    const draft = `“${text}” [来源](${a})`;
    for (let i = 0; i < 24; i++) ledger.observe(`s${i}`, [receipt(text)]);
    expect(
      passes(
        review(
          ledger,
          [
            {
              text: draft,
              kind: 'quotation',
              evidence: [anchor(text, 's0:0')],
            },
          ],
          draft,
        ),
      ),
    ).toBe(true);
    expect(ledger.observe('overflow', [receipt(text)])).toBe(false);
    expect(ledger.checks(draft, 1).some((c) => c.status !== 'passed')).toBe(
      true,
    );
  });
  it('requires an explicit same-subject metric/period/unit binding for numerical inference', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Acme revenue FY2025 USD 42 billion.';
    ledger.observe('fetch', [receipt(text)]);
    const draft = `Acme revenue FY2025 USD 42 billion，可能支持后续投入。 [来源](${a})`;
    const claim = { text: draft, kind: 'inference', evidence: [anchor(text)] };
    expect(passes(review(ledger, [claim], draft))).toBe(false);
    expect(
      passes(
        review(
          ledger,
          [
            {
              ...claim,
              facet: {
                subject: 'Acme',
                metric: 'revenue',
                period: 'FY2025',
                unit: 'USD',
              },
              evidence: [anchor(text, 'fetch:0', '42')],
            },
          ],
          draft,
        ),
      ),
    ).toBe(true);
  });
  it('keeps a signed value signed; negative evidence cannot justify a positive value', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Acme growth FY2025 -12%.';
    ledger.observe('fetch', [receipt(text)]);
    const draft = `Acme growth FY2025 12%，可能持续。 [来源](${a})`;
    expect(
      passes(
        review(
          ledger,
          [
            {
              text: draft,
              kind: 'inference',
              facet: {
                subject: 'Acme',
                metric: 'growth',
                period: 'FY2025',
                unit: '%',
              },
              evidence: [anchor(text, 'fetch:0', '12%')],
            },
          ],
          draft,
        ),
      ),
    ).toBe(false);
  });
  it('detects differently worded same-facet conflicts and retains exact conflict locations', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Acme revenue FY2025 USD 42 billion.';
    const other = 'FY2025: Acme reported revenue of USD 45 billion.';
    ledger.observe('fetch', [receipt(text), receipt(other, b)]);
    const draft = `“${text}” [来源](${a})`;
    const result = review(
      ledger,
      [
        {
          text: draft,
          kind: 'quotation',
          facet: {
            subject: 'Acme',
            metric: 'revenue',
            period: 'FY2025',
            unit: 'USD',
          },
          evidence: [anchor(text, 'fetch:0', '42')],
        },
      ],
      draft,
    );
    expect(passes(result)).toBe(false);
    expect(result.claims[0].conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'fetch:1',
          quote: other,
          value: '45',
          sourceHash: receipt(other).sha256,
        }),
      ]),
    );
  });
  it('does not confuse different periods or different metrics with a contradiction', () => {
    const ledger = new ClaimEvidenceLedger();
    const text = 'Acme revenue FY2025 USD 42 billion.';
    ledger.observe('fetch', [
      receipt(text),
      receipt('Acme revenue FY2024 USD 45 billion.', b),
      receipt('Acme profit FY2025 USD 45 billion.', 'https://example.com/c'),
    ]);
    const draft = `“${text}” [来源](${a})`;
    expect(
      passes(
        review(
          ledger,
          [
            {
              text: draft,
              kind: 'quotation',
              facet: {
                subject: 'Acme',
                metric: 'revenue',
                period: 'FY2025',
                unit: 'USD',
              },
              evidence: [anchor(text, 'fetch:0', '42')],
            },
          ],
          draft,
        ),
      ),
    ).toBe(true);
  });
  it('covers requested periods across separate claims instead of demanding every year in every quote', () => {
    const ledger = new ClaimEvidenceLedger();
    const first = 'Acme FY2025 revenue 42.';
    const second = 'Acme FY2026 revenue 45.';
    ledger.observe('fetch', [receipt(first), receipt(second, b)]);
    const claims = [first, second].map((text, i) => ({
      text: `“${text}” [来源](${i ? b : a})`,
      kind: 'quotation',
      evidence: [anchor(text, `fetch:${i}`)],
    }));
    expect(
      passes(
        review(
          ledger,
          claims,
          claims.map((c) => c.text).join('\n'),
          '比较2025和2026的营收',
        ),
      ),
    ).toBe(true);
    const missing = review(
      ledger,
      [claims[0]],
      claims[0].text,
      '比较2025和2026的营收',
    );
    expect(
      missing.checks.find((c) => c.id === 'claims:requested-period')?.status,
    ).not.toBe('passed');
  });
});
