/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import defaultSources from './policy-sources.json' with { type: 'json' };
import { loadPolicyAttachment } from './policyAttachments.js';
import { nationalProvinceSources } from './policyNationalSources.js';
import type { PolicySource, OfficialPolicyDocument } from './contracts.js';
import {
  normalizePolicyRegion,
  policyHash,
  policyDate,
} from './policyDomain.js';

export function officialPolicyUrl(
  value: string,
  hosts: readonly string[],
): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      hosts.includes(url.hostname) &&
      /(?:^|\.)gov\.cn$/u.test(url.hostname)
    );
  } catch {
    return false;
  }
}
export function validatePolicySources(raw: unknown): PolicySource[] {
  if (!Array.isArray(raw) || raw.length > 1000)
    throw new Error('政策来源配置必须为有限列表');
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object')
      throw new Error('政策来源格式错误');
    const item = entry as PolicySource;
    if (
      !/^[a-z0-9_-]{1,80}$/u.test(item.id) ||
      seen.has(item.id) ||
      typeof item.name !== 'string' ||
      item.name.length > 100
    )
      throw new Error('政策来源标识重复或无效');
    if (
      !Array.isArray(item.allowedHosts) ||
      item.allowedHosts.length === 0 ||
      item.allowedHosts.some(
        (host) =>
          typeof host !== 'string' || !/^(?:[a-z0-9-]+\.)*gov\.cn$/u.test(host),
      )
    )
      throw new Error('只允许已审核的官方域名');
    if (!officialPolicyUrl(item.listUrl, item.allowedHosts))
      throw new Error('政策来源地址未通过官方白名单校验');
    const region = normalizePolicyRegion(item.region);
    if (
      !['national', 'province', 'city', 'district'].includes(item.level) ||
      (item.level === 'province' && !region.province) ||
      (item.level === 'city' && !region.city) ||
      (item.level === 'district' && (!region.city || !region.district))
    )
      throw new Error('政策来源必须绑定完整的对应地区');
    seen.add(item.id);
    return { ...item, region };
  });
}
export function loadPolicySources(): PolicySource[] {
  const file = process.env.OTTO_POLICY_SOURCES_FILE?.trim();
  return validatePolicySources(
    file
      ? (JSON.parse(readFileSync(file, 'utf8')) as unknown)
      : [...defaultSources, ...nationalProvinceSources],
  );
}
function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#(\d+);/gu, (_match, code: string) => {
      const number = Number(code);
      return number >= 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : '';
    });
}
export function policyText(html: string): string {
  return decodeHtml(
    html
      .replace(
        /<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/giu,
        ' ',
      )
      .replace(/<[^>]+>/gu, ' '),
  )
    .replace(/\s+/gu, ' ')
    .trim();
}
export async function fetchPolicyHtml(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    headers: {
      Accept: 'text/html, text/plain;q=0.8',
      'User-Agent': 'Otto-Policy-Intelligence/2.0',
    },
  });
  if (!response.ok) throw new Error(`官方来源 HTTP ${response.status}`);
  if (
    !/(?:text\/html|text\/plain|application\/xhtml)/iu.test(
      response.headers.get('content-type') ?? 'text/html',
    )
  )
    throw new Error('该来源需要专用采集适配器');
  const limit = 2500000;
  if (Number(response.headers.get('content-length') ?? 0) > limit)
    throw new Error('官方页面超过大小限制');
  if (!response.body) throw new Error('官方页面内容为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('官方页面超过大小限制');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks);
  const encoding = /(?:gb2312|gbk|gb18030)/iu.test(
    (response.headers.get('content-type') ?? '') +
      bytes.subarray(0, 2048).toString('latin1'),
  )
    ? 'gb18030'
    : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}
export function policyLinks(
  html: string,
  source: PolicySource,
  minTitleLength = 8,
  keepNavigation = false,
): Array<{ title: string; url: string }> {
  const found = new Map<string, string>();
  if (!keepNavigation)
    html = html.replace(
      /<(?:nav|header|footer)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer)>/giu,
      '',
    );
  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
  )) {
    const title = policyText(match[2]);
    if (title.length < minTitleLength || title.length > 250) continue;
    let url: URL;
    try {
      url = new URL(decodeHtml(match[1]), source.listUrl);
      if (
        url.protocol === 'http:' &&
        source.allowedHosts.includes(url.hostname)
      )
        url.protocol = 'https:';
    } catch {
      continue;
    }
    url.hash = '';
    if (
      officialPolicyUrl(url.href, source.allowedHosts) &&
      url.href !== source.listUrl
    )
      found.set(url.href, title);
  }
  // Discovery is intentionally not a hard-coded five-category keyword filter.
  return [...found]
    .map(([url, title]) => ({ url, title }))
    .slice(0, keepNavigation ? 500 : 100);
}
export async function collectPolicySource(
  source: PolicySource,
  fetcher: typeof fetch,
  signal: AbortSignal,
  now = new Date(),
  onDetailFailure?: (url: string) => void,
  knownDocuments: readonly OfficialPolicyDocument[] = [],
  priorityIds: ReadonlySet<string> = new Set(),
): Promise<OfficialPolicyDocument[]> {
  validatePolicySources([source]);
  const list = await fetchPolicyHtml(source.listUrl, fetcher, signal);
  let links = policyLinks(list, source).slice(0, 12);
  if (source.discovery === 'portal') {
    const listingTitle =
      /^(?:(?:省|市)?政府(?:办公厅)?文件|政策文件库|政策文件|政策法规|行政规范性文件|最新政策|最新文件|法规文件|文件库|文件|政策)$/u;
    const portalLinks = policyLinks(list, source, 2, true);
    const listings = portalLinks
      .filter((link) => listingTitle.test(link.title))
      .slice(0, 3);
    const found = new Map<string, { title: string; url: string }>();
    for (const listing of listings) {
      try {
        const html = await fetchPolicyHtml(listing.url, fetcher, signal);
        for (const link of policyLinks(html, {
          ...source,
          listUrl: listing.url,
        }))
          if (
            /通知|办法|细则|公告|通告|规定|条例|指南|批复|意见|决定|公示|申报/u.test(
              link.title,
            ) &&
            !/\.(?:pdf|docx?|xlsx?|zip)(?:\?|$)/iu.test(link.url)
          )
            found.set(link.url, link);
      } catch {
        signal.throwIfAborted();
      }
    }
    if (!found.size)
      for (const link of portalLinks)
        if (
          /(?:人民政府|政府办公厅).*关于.+(?:通知|意见|办法|决定|批复)$/u.test(
            link.title,
          )
        )
          found.set(link.url, link);
    links = [...found.values()].slice(0, 6);
  }
  const knownLinks = new Set(links.map((item) => item.url));
  for (const doc of policyRecheckCandidates(
    knownDocuments.filter(
      (doc) => doc.sourceId === source.id && !knownLinks.has(doc.url),
    ),
    now,
    priorityIds,
  ))
    if (officialPolicyUrl(doc.url, source.allowedHosts))
      links.push({ url: doc.url, title: doc.title });
  if (!links.length)
    throw new Error('该来源暂未返回可采集条目，可能需要专用适配器');
  const documents: OfficialPolicyDocument[] = [];
  const initialLinks = new Set(links.map((link) => link.url));
  let relatedFetches = 0;
  for (const link of links) {
    signal.throwIfAborted();
    let html: string;
    try {
      html = await fetchPolicyHtml(link.url, fetcher, signal);
    } catch {
      signal.throwIfAborted();
      onDetailFailure?.(link.url);
      continue;
    }
    const title = policyText(
      html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] ?? link.title,
    );
    if (
      /访问验证|验证码|访问被拒绝|访问受限|Access Denied|Robot Check/iu.test(
        title,
      )
    ) {
      onDetailFailure?.(link.url);
      continue;
    }
    const main =
      html.match(
        /<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/iu,
      )?.[1] ?? html;
    const referencedLinks = policyLinks(
      main,
      { ...source, listUrl: link.url },
      1,
    );
    if (initialLinks.has(link.url))
      for (const ref of referencedLinks) {
        if (relatedFetches >= 4) break;
        if (
          !/办法|实施细则|20\d{2}年度.*申报/u.test(ref.title) ||
          /\.(?:pdf|docx?|xlsx?|zip)(?:\?|$)/iu.test(ref.url) ||
          links.some((item) => item.url === ref.url)
        )
          continue;
        links.push(ref);
        relatedFetches++;
      }
    let bodyText =
      policyText(main) +
      (referencedLinks.length
        ? '\n原文链接：\n' +
          referencedLinks.map((item) => `${item.title}：${item.url}`).join('\n')
        : '');
    if (bodyText.length < 15 || bodyText.length > 100000) {
      onDetailFailure?.(link.url);
      continue;
    }
    const attachmentLinks: OfficialPolicyDocument['attachments'] = [];
    // Unlike source discovery, attachment accounting must retain rejected links:
    // a blocked required attachment is missing evidence, never 'no attachment'.
    for (const match of main.matchAll(
      /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
    )) {
      const label = policyText(match[2]).slice(0, 250) || '未命名附件';
      if (
        !/\.(?:pdf|docx?|xlsx?|zip|rar|7z)(?:\?|$)/iu.test(match[1]) &&
        !/附件|下载/u.test(label)
      )
        continue;
      let url = '';
      try {
        const target = new URL(decodeHtml(match[1]), link.url);
        if (
          target.protocol === 'http:' &&
          source.allowedHosts.includes(target.hostname)
        )
          target.protocol = 'https:';
        if (officialPolicyUrl(target.href, source.allowedHosts))
          url = target.href;
      } catch {
        /* keep the missing-evidence marker */
      }
      if (url && attachmentLinks.some((a) => a.url === url)) continue;
      attachmentLinks.push({
        label,
        url: url || `#blocked-attachment-${attachmentLinks.length}`,
        parsed: false,
        ...(!url
          ? {
              status: 'unsupported' as const,
              reason: '附件不在已审核官方白名单，禁止自动访问，需要人工核验',
            }
          : {}),
      });
      if (attachmentLinks.length >= 100) break;
    }
    const attachments: OfficialPolicyDocument['attachments'] = [];
    for (const attachment of attachmentLinks) {
      if (attachment.status === 'unsupported') {
        attachments.push(attachment);
        continue;
      }
      if (attachments.length >= 8) {
        attachments.push({
          ...attachment,
          status: 'unsupported',
          reason: '单篇附件数量超限，请人工核验',
        });
        continue;
      }
      const parsed = await loadPolicyAttachment(
        attachment,
        source.allowedHosts,
        fetcher,
        signal,
      );
      const evidence = (parsed.sections ?? [])
        .map(
          (s) =>
            `【附件：${parsed.label}；${s.locator}；来源 ${parsed.url}】\n${s.text}`,
        )
        .join('\n');
      if (bodyText.length + evidence.length > 100000)
        attachments.push({
          ...attachment,
          sha256: parsed.sha256,
          status: 'partial',
          reason: '正文与附件合计超过分析上限，请人工核验',
        });
      else {
        attachments.push(parsed);
        if (parsed.parsed) bodyText += `\n${evidence}`;
      }
    }
    documents.push({
      id: policyHash(link.url).slice(0, 32),
      title,
      url: link.url,
      sourceId: source.id,
      sourceName: source.name,
      level: source.level,
      region: source.region,
      issuer: source.name,
      categories: [],
      fetchedAt: now.toISOString(),
      contentHash: policyHash([title, bodyText, attachments]),
      version: 1,
      bodyText,
      summary: '',
      supportText: '',
      conditions: [],
      conditionTree: { all: [] },
      materials: [],
      resources: [],
      attachments,
      references: referencedLinks
        .filter((ref) => !attachmentLinks.some((a) => a.url === ref.url))
        .map((ref) => ({ label: ref.title, url: ref.url })),
      sourceStatus: 'verified',
      interpretationStatus: 'pending',
    });
  }
  if (!documents.length) throw new Error('该来源没有可核验的有效正文');
  return documents;
}

/** A bounded rotating review, not a claim of comprehensive historical coverage. */
export function policyRecheckCandidates(
  documents: readonly OfficialPolicyDocument[],
  now: Date,
  priorityIds: ReadonlySet<string> = new Set(),
): OfficialPolicyDocument[] {
  return documents
    .filter((doc) => {
      const deadline = policyDate(doc.deadline, true);
      const nearDeadline =
        deadline !== undefined &&
        deadline >= now.getTime() &&
        deadline - now.getTime() <= 14 * 86400000;
      const age = now.getTime() - Date.parse(doc.fetchedAt);
      return (
        !Number.isFinite(age) ||
        age >=
          (nearDeadline
            ? 12 * 3600000
            : priorityIds.has(doc.id)
              ? 86400000
              : 7 * 86400000)
      );
    })
    .sort(
      (a, b) =>
        Number(priorityIds.has(b.id)) - Number(priorityIds.has(a.id)) ||
        a.fetchedAt.localeCompare(b.fetchedAt),
    )
    .slice(0, 4);
}
