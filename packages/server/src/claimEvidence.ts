/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import type { WebSourceReceipt } from 'otto-core';
import type { TurnVerificationCheck } from './protocol.js';

type Anchor = {
  sourceId: string;
  start: number;
  end: number;
  value?: string;
  quote?: string;
  sourceHash?: string;
  retrievedAt?: string;
};
type Claim = {
  text: string;
  kind: 'quotation' | 'inference' | 'uncertain';
  evidence: Anchor[];
  facet?: { subject: string; metric: string; period: string; unit: string };
};
type Source = WebSourceReceipt & {
  id: string;
  toolCallId: string;
  authority: 'unverified';
};
type Conflict = Anchor & { uri: string; reason: string };
export interface ClaimReview {
  requestRevision: number;
  draftHash: string;
  sourceRevision: number;
  checks: TurnVerificationCheck[];
  sources: Array<Omit<Source, 'text'>>;
  claims: Array<
    Claim & {
      status: 'attributed' | 'inference' | 'uncertain' | 'unsupported';
      reasons: string[];
      conflicts: Conflict[];
    }
  >;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/gu, '$1')
    .replace(/[“”「」"*`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
const stripLinks = (text: string) =>
  text.replace(/\[[^\]]*\]\(https?:\/\/[^\s)]+\)/gu, '').trim();
const numeric = (text: string) =>
  [...text.matchAll(/[+\-−]?\d+(?:[,.]\d+)*%?/gu)].map((m) => m[0]);
// Offsets always refer to the original receipt, including punctuation. Avoid
// combining a subject from one sentence with another sentence's numeric value.
function passages(
  text: string,
): Array<{ start: number; end: number; text: string }> {
  const output: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  for (const end of [...text.matchAll(/[。！？!?\n]|\.(?=\s|$)/gu)]
    .map((m) => m.index + m[0].length)
    .concat(text.length)) {
    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed && trimmed.length <= 2000) {
      const offset = start + raw.indexOf(trimmed);
      output.push({
        start: offset,
        end: offset + trimmed.length,
        text: trimmed,
      });
    }
    start = end;
  }
  return output;
}
function facetValues(
  text: string,
  facet: NonNullable<Claim['facet']>,
): string[] | undefined {
  if (!Object.values(facet).every((part) => text.includes(part)))
    return undefined;
  // Period/subject digits are not the metric value. No implicit arithmetic,
  // rounding, sign normalization or currency/unit conversion is certified.
  return numeric(
    [facet.subject, facet.metric, facet.period].reduce(
      (remaining, part) => remaining.replaceAll(part, ''),
      text,
    ),
  );
}
const uncertainty =
  /尚未证实|无法确认|证据不足|存在冲突|暂不能确认|\b(?:unverified|uncertain|conflicting evidence)\b/iu;
const inference = /可能|推测|不确定|\b(?:may|might|uncertain|possibly)\b/iu;
// Recognition of visible caveats, not required sentences or proof of recency.
const recencyCaveat =
  /时效性尚未核实|尚未确认这是最新|未确认是最新|recency (?:is )?unverified|(?:无法|未能|尚未|不能)(?:核实|确认|验证)[^。！？\n]{0,48}(?:最新|时效|发布日期|发布时间)/iu;
const authorityCaveat =
  /来源权威性尚未核实|未核实一手来源身份|source authority (?:is )?unverified|(?:无法|未能|尚未|不能)(?:核实|确认|验证)[^。！？\n]{0,48}(?:发布者身份|一手来源身份|来源权威性|官方身份)/iu;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a structured evidence object');
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Missing or oversized evidence string');
  return value;
}
function parseClaim(value: unknown): Claim {
  const raw = object(value);
  if (!['quotation', 'inference', 'uncertain'].includes(String(raw.kind)))
    throw new Error('Unknown claim kind');
  if (!Array.isArray(raw.evidence) || raw.evidence.length > 8)
    throw new Error('At most eight anchors per claim');
  const evidence = raw.evidence.map((v) => {
    const a = object(v);
    if (
      !Number.isInteger(a.start) ||
      !Number.isInteger(a.end) ||
      Number(a.start) < 0 ||
      Number(a.end) <= Number(a.start) ||
      Number(a.end) > 12000 ||
      Number(a.end) - Number(a.start) > 2000
    )
      throw new Error('Invalid source offsets');
    return {
      sourceId: string(a.sourceId, 180),
      start: Number(a.start),
      end: Number(a.end),
      ...(a.value !== undefined ? { value: string(a.value, 60) } : {}),
    };
  });
  const facet = raw.facet === undefined ? undefined : object(raw.facet);
  return {
    text: string(raw.text, 4000),
    kind: raw.kind as Claim['kind'],
    evidence,
    ...(facet
      ? {
          facet: {
            subject: string(facet.subject, 120),
            metric: string(facet.metric, 120),
            period: string(facet.period, 120),
            unit: string(facet.unit, 80),
          },
        }
      : {}),
  };
}

/** Native lower-bound review. Attribution is deliberately not labelled truth.
 * No second agent loop, semantic oracle or model self-issued verification. */
export class ClaimEvidenceLedger {
  private sources = new Map<string, Source>();
  private sourceRevision = 0;
  private reviewState?: ClaimReview;
  private overflow = false;
  private ingestionFailures = new Set<string>();

  private rejectReceipt(toolCallId: string): false {
    this.reviewState = undefined;
    this.sourceRevision++;
    if (this.ingestionFailures.size < 24 && toolCallId.length <= 150)
      this.ingestionFailures.add(toolCallId);
    else this.overflow = true;
    return false;
  }

  observe(toolCallId: string, receipts: readonly WebSourceReceipt[]): boolean {
    if (
      !receipts.length ||
      receipts.length > 4 ||
      !toolCallId ||
      toolCallId.length > 150
    )
      return this.rejectReceipt(toolCallId);
    const additions: Source[] = [];
    for (const [index, r] of receipts.entries()) {
      if (
        typeof r.text !== 'string' ||
        !r.text.trim() ||
        r.text.length > 12000 ||
        hash(r.text) !== r.sha256 ||
        !Number.isFinite(Date.parse(r.retrievedAt)) ||
        Date.parse(r.retrievedAt) > Date.now() + 60000 ||
        typeof r.truncated !== 'boolean'
      )
        return this.rejectReceipt(toolCallId);
      try {
        const u = new URL(r.uri);
        if (
          r.uri.length > 4096 ||
          !['http:', 'https:'].includes(u.protocol) ||
          u.username ||
          u.password ||
          [...u.searchParams.keys()].some((k) =>
            /token|key|secret|signature|auth|password/iu.test(k),
          )
        )
          return this.rejectReceipt(toolCallId);
      } catch {
        return this.rejectReceipt(toolCallId);
      }
      additions.push({
        ...r,
        id: `${toolCallId}:${index}`,
        toolCallId,
        authority: 'unverified',
      });
    }
    if (
      new Set([...this.sources.keys(), ...additions.map((s) => s.id)]).size > 24
    ) {
      this.overflow = true;
      return this.rejectReceipt(toolCallId);
    }
    if (this.ingestionFailures.delete(toolCallId)) {
      this.reviewState = undefined;
      this.sourceRevision++;
    }
    // Replacement receipts cannot leave removed pages from this call active.
    for (const [id, source] of this.sources) {
      if (
        source.toolCallId === toolCallId &&
        !additions.some((s) => s.id === id)
      ) {
        this.sources.delete(id);
        this.sourceRevision++;
      }
    }
    for (const s of additions) {
      if (JSON.stringify(this.sources.get(s.id)) !== JSON.stringify(s)) {
        this.sources.set(s.id, structuredClone(s));
        this.sourceRevision++;
      }
    }
    return true;
  }

  review(
    value: unknown,
    currentRevision: number,
    requestText = '',
  ): ClaimReview {
    // Clear any earlier passing review even when a replacement is malformed.
    this.reviewState = undefined;
    const raw = object(value);
    if (raw.requestRevision !== currentRevision)
      throw new Error('Evidence review must use the current request revision');
    const draft = string(raw.draft, 32000);
    if (
      !Array.isArray(raw.claims) ||
      raw.claims.length < 1 ||
      raw.claims.length > 64
    )
      throw new Error('Supply 1-64 claims, do not drop excess claims');
    const claims = raw.claims.map(parseClaim);
    if (new Set(claims.map((c) => c.text)).size !== claims.length)
      throw new Error('Duplicate claim text');
    const sourcePassages = new Map(
      [...this.sources.values()].map((s) => [s.id, passages(s.text)]),
    );
    let conflictCount = 0;
    let remainder = draft;
    const evaluated = claims.map((claim) => {
      const reasons: string[] = [];
      const conflicts: Conflict[] = [];
      const addConflict = (
        source: Source,
        start: number,
        end: number,
        reason: string,
        value?: string,
      ) => {
        if (
          conflicts.some(
            (c) =>
              c.sourceId === source.id && c.start === start && c.end === end,
          )
        )
          return;
        if (conflicts.length >= 16 || conflictCount >= 64) {
          if (!reasons.includes('矛盾证据超出审查容量，需缩小任务范围'))
            reasons.push('矛盾证据超出审查容量，需缩小任务范围');
          return;
        }
        conflictCount++;
        conflicts.push({
          sourceId: source.id,
          start,
          end,
          quote: source.text.slice(start, end),
          sourceHash: source.sha256,
          retrievedAt: source.retrievedAt,
          uri: source.uri,
          reason,
          ...(value ? { value } : {}),
        });
      };
      if (!remainder.includes(claim.text))
        reasons.push('结论不在当前正文中或重复覆盖');
      else remainder = remainder.replace(claim.text, '');
      const quotes: string[] = [];
      const uris: string[] = [];
      const values = new Set<string>();
      for (const anchor of claim.evidence) {
        const source = this.sources.get(anchor.sourceId);
        if (!source || anchor.end > source.text.length) {
          reasons.push('缺少原文或段落位置越界');
          continue;
        }
        const quote = source.text.slice(anchor.start, anchor.end);
        anchor.quote = quote;
        anchor.sourceHash = source.sha256;
        anchor.retrievedAt = source.retrievedAt;
        quotes.push(quote);
        uris.push(source.uri);
        for (const [positive, negative] of [
          ['支持', '不支持'],
          ['已启用', '未启用'],
          ['允许', '不允许'],
          ['supports', 'does not support'],
          ['available', 'unavailable'],
        ]) {
          const opposite = quote.includes(negative)
            ? quote.replace(negative, positive)
            : quote.includes(positive)
              ? quote.replace(positive, negative)
              : undefined;
          if (opposite)
            for (const other of this.sources.values()) {
              const start = other.text.indexOf(opposite);
              if (other.id !== source.id && start >= 0)
                addConflict(other, start, start + opposite.length, 'polarity');
            }
        }
        if (claim.facet) {
          const facet = claim.facet;
          const selected = passages(quote)
            .map((p) => facetValues(p.text, facet))
            .filter((v) => v !== undefined);
          if (
            !anchor.value ||
            !selected.some((v) => v.length === 1 && v[0] === anchor.value)
          )
            reasons.push(
              '主体、指标、时间、单位和带符号数值必须绑定同一条无歧义原文；多指标段落需缩小引用范围',
            );
          if (anchor.value)
            for (const other of this.sources.values()) {
              for (const passage of sourcePassages.get(other.id)!) {
                const candidates = facetValues(passage.text, facet);
                if (!candidates?.length) continue;
                if (candidates.length !== 1) {
                  if (claim.kind !== 'uncertain')
                    reasons.push(
                      '同口径来源含多个数值，尚不能排除歧义，不能自动认定一致',
                    );
                } else if (candidates[0] !== anchor.value)
                  addConflict(
                    other,
                    passage.start,
                    passage.end,
                    'same-facet-value',
                    candidates[0],
                  );
              }
            }
        }
        if (anchor.value) values.add(anchor.value);
        // Compare structurally identical numeric statements from ALL retrieved
        // sources, not just the favorable anchors selected by the model.
        for (const match of quote.matchAll(/[+\-−]?\d+(?:[,.]\d+)*%?/gu)) {
          if (/^(?:19|20)\d{2}$/.test(match[0])) continue;
          const before = quote.slice(0, match.index);
          const after = quote.slice(match.index! + match[0].length);
          if (before.length < 8 || !after.trim()) continue;
          for (const other of this.sources.values()) {
            const start = other.text.indexOf(before);
            if (start < 0) continue;
            const rest = other.text.slice(start + before.length);
            const n = rest.match(/^[+\-−]?\d+(?:[,.]\d+)*%?/u)?.[0];
            if (n && rest.slice(n.length).startsWith(after) && n !== match[0])
              addConflict(
                other,
                start,
                start + before.length + n.length + after.length,
                'same-statement-value',
                n,
              );
          }
        }
      }
      const conflict = values.size > 1 || conflicts.length > 0;
      if (
        conflict &&
        (claim.kind !== 'uncertain' ||
          !/冲突|不一致|conflict/iu.test(claim.text))
      )
        reasons.push('相同时间和口径存在矛盾数值，必须保留冲突和不确定性');
      if (
        conflict &&
        claim.kind === 'uncertain' &&
        ![...uris, ...conflicts.map((c) => c.uri)].every((uri) =>
          claim.text.includes(`](${uri})`),
        )
      )
        reasons.push('冲突说明必须链接双方证据，不能只展示有利来源');
      // A clickable label is visible answer text, not a place to hide a new
      // assertion. Neutral citation markers need no extra narrative template;
      // descriptive labels must themselves occur in the linked evidence.
      for (const link of claim.text.matchAll(
        /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gu,
      )) {
        const label = plain(link[1]);
        if (
          !/^(?:(?:来源|原文|证据|报告|source|report|reference|ref|\d+)(?:\s*\d+)?|来源链接)$/iu.test(
            label,
          ) &&
          !claim.evidence.some(
            (a) =>
              this.sources.get(a.sourceId)?.uri === link[2] &&
              a.quote?.includes(label),
          )
        )
          reasons.push(
            '来源链接的可见文字包含未绑定的结论；需使用中性引用标记或对应原文',
          );
      }
      if (claim.kind === 'quotation') {
        const content = plain(stripLinks(claim.text)).replace(
          /^(?:该页记载[:：]?|原文[:：]?|Source states[:：]?|According to the source[:：]?)\s*/iu,
          '',
        );
        const attributed =
          /^(?:该页记载|原文|Source states|According to the source)/iu.test(
            claim.text,
          ) || /^(?:“[^”]+”|「[^」]+」|"[^"]+")$/u.test(stripLinks(claim.text));
        if (!attributed || !quotes.some((q) => plain(q) === content))
          reasons.push(
            '只能核实明确归属于来源的原文引述；改写或推论需标注推断/不确定',
          );
        if (
          !claim.evidence.some(
            (a) =>
              a.quote &&
              plain(a.quote) === content &&
              claim.text.includes(`](${this.sources.get(a.sourceId)?.uri})`),
          )
        )
          reasons.push('结论旁缺少对应的来源链接');
      } else if (claim.kind === 'inference') {
        if (
          !inference.test(stripLinks(claim.text)) ||
          !quotes.length ||
          /已经证实|肯定|一定|definitely|proven/iu.test(stripLinks(claim.text))
        )
          reasons.push('推断必须明确标注不确定性并附具体证据');
        if (
          numeric(stripLinks(claim.text)).some(
            (n) => !quotes.some((q) => numeric(q).includes(n)),
          )
        )
          reasons.push('推断中的新增数值没有原文支撑，计算结果需独立验算');
        if (
          numeric(stripLinks(claim.text)).length &&
          (!claim.facet ||
            !claim.evidence.every((a) => !!a.value) ||
            Object.values(claim.facet).some(
              (part) => !stripLinks(claim.text).includes(part),
            ))
        )
          reasons.push(
            '数值推断必须显式绑定主体、指标、期间、单位和原文值，正文口径也必须一致',
          );
        if (numeric(stripLinks(claim.text)).length && claim.facet) {
          const body = plain(stripLinks(claim.text));
          const facet = claim.facet;
          const literalBasis = quotes.flatMap(passages).some((p) => {
            if (facetValues(p.text, facet)?.length !== 1) return false;
            const basis = plain(p.text).replace(/[.!?。！？]+$/u, '');
            return (
              body.includes(basis) && !numeric(body.replace(basis, '')).length
            );
          });
          if (!literalBasis)
            reasons.push(
              '数值依据需保留原文口径再作推断；翻译、换算、改写或新增数字尚无独立验证',
            );
        }
        if (
          !uris.length ||
          !uris.every((uri) => claim.text.includes(`](${uri})`))
        )
          reasons.push('推断旁缺少证据链接');
      } else if (
        !uncertainty.test(stripLinks(claim.text)) ||
        /已经证实|肯定|一定|definitely|proven/iu.test(claim.text)
      )
        reasons.push('证据不足必须在该结论正文中明确说明，不能只在元数据标注');
      return {
        ...claim,
        status: reasons.length
          ? ('unsupported' as const)
          : claim.kind === 'quotation'
            ? ('attributed' as const)
            : claim.kind,
        reasons,
        conflicts,
      };
    });
    const checks: TurnVerificationCheck[] = [
      {
        id: 'claims:coverage',
        label: '当前正文每个段落都有结论—证据或明确不确定性说明',
        status: remainder.replace(/[\s#>*_-]/gu, '') ? 'not_run' : 'passed',
      },
      ...evaluated.map((claim, i) => ({
        id: `claim:${i}`,
        label:
          claim.reasons.join('；') ||
          '原文归属/不确定性检查通过（不等于事实真伪认证）',
        status:
          claim.status === 'unsupported'
            ? ('failed' as const)
            : ('passed' as const),
        evidence: claim.evidence.map(
          (a) => `${a.sourceId}@${a.start}:${a.end}`,
        ),
      })),
    ];
    const years = [
      ...new Set(requestText.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/gu) ?? []),
    ];
    if (
      years.length &&
      !years.every((year) =>
        evaluated.some(
          (c) =>
            c.status !== 'unsupported' &&
            (c.kind === 'uncertain'
              ? stripLinks(c.text).includes(year)
              : stripLinks(c.text).includes(year) &&
                c.evidence.some((a) => a.quote?.includes(year))),
        ),
      )
    )
      checks.push({
        id: 'claims:requested-period',
        label: '部分结论缺少用户指定期间的原文；历史数值不能冒充指定年份结论',
        status: 'not_run',
      });
    if (
      /最新|实时|目前|今天|latest|current|today/iu.test(requestText) &&
      !recencyCaveat.test(stripLinks(draft))
    )
      checks.push({
        id: 'claims:freshness',
        label:
          '抓取时间不等于发布时间；请自然说明尚无法确认是否最新，一处说明即可，不能自动认证时效',
        status: 'not_run',
      });
    if (
      /一手|官方|primary source|official/iu.test(requestText) &&
      !authorityCaveat.test(stripLinks(draft))
    )
      checks.push({
        id: 'claims:authority',
        label:
          '尚无可信发布者认证；自然说明身份无法核实即可，不要求固定措辞或逐段重复',
        status: 'not_run',
      });
    if (this.overflow)
      checks.push({
        id: 'claims:overflow',
        label: '证据超过本轮审查容量，需拆分任务，不得静默丢弃',
        status: 'not_run',
      });
    if (this.ingestionFailures.size)
      checks.push({
        id: 'claims:source-integrity',
        label: '存在未纠正的来源回执校验失败，旧证据审查不能继续放行',
        status: 'not_run',
      });
    this.reviewState = {
      requestRevision: currentRevision,
      draftHash: hash(draft),
      sourceRevision: this.sourceRevision,
      checks,
      claims: evaluated,
      sources: [...this.sources.values()].map(({ text: _text, ...s }) => s),
    };
    return structuredClone(this.reviewState);
  }

  checks(draft: string, requestRevision: number): TurnVerificationCheck[] {
    if (
      !this.reviewState ||
      this.reviewState.requestRevision !== requestRevision ||
      this.reviewState.draftHash !== hash(draft) ||
      this.reviewState.sourceRevision !== this.sourceRevision
    )
      return [
        {
          id: 'claims:current-review',
          label:
            '当前正文尚未绑定当前请求和来源版本；先用 web_fetch evidence_only 获取原文，再用 review_answer_evidence 登记；无法核实的部分明确保留不确定性',
          status: 'not_run',
        },
      ];
    return structuredClone(this.reviewState.checks);
  }
  snapshot(): ClaimReview | undefined {
    return this.reviewState && structuredClone(this.reviewState);
  }
  hasEvidence(): boolean {
    return this.sources.size > 0 || !!this.reviewState;
  }
}
