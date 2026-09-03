/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import defaultSources from './policy-sources.json' with { type: 'json' };
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
    file ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : defaultSources,
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
    response.headers.get('content-type') ?? '',
  )
    ? 'gb18030'
    : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}
export function policyLinks(
  html: string,
  source: PolicySource,
  minTitleLength = 8,
): Array<{ title: string; url: string }> {
  const found = new Map<string, string>();
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
  return [...found].map(([url, title]) => ({ url, title })).slice(0, 30);
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
  const links = policyLinks(list, source).slice(0, 12);
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
    const main =
      html.match(
        /<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/iu,
      )?.[1] ?? html;
    const referencedLinks = policyLinks(
      main,
      { ...source, listUrl: link.url },
      1,
    );
    const bodyText =
      policyText(main) +
      (referencedLinks.length
        ? '\n原文链接：\n' +
          referencedLinks.map((item) => `${item.title}：${item.url}`).join('\n')
        : '');
    if (bodyText.length < 15 || bodyText.length > 100000) {
      onDetailFailure?.(link.url);
      continue;
    }
    const attachments = referencedLinks
      .filter(
        (item) =>
          /\.(?:pdf|docx?|xlsx?)(?:\?|$)/iu.test(item.url) ||
          /附件|下载/u.test(item.title),
      )
      .map((item) => ({ label: item.title, url: item.url, parsed: false }));
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
