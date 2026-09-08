/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from './recruitmentSemantic.js';
import { readRecruitmentOrganizationBudget, type RecruitmentOrganizationBudget } from './recruitmentUsageLedger.js';

export interface RecruitmentBackgroundModel {
  id: string; version: string;
  organizationBudget?: RecruitmentOrganizationBudget;
  invoke(prompt: string, signal: AbortSignal): Promise<{ raw: string; inputTokens: number | null; outputTokens: number | null }>;
}

/** Operator-owned routing only. No renderer endpoint, desktop token, wildcard tenants or default paid calls. */
export function resolveRecruitmentBackgroundModel(organizationId: string, env: NodeJS.ProcessEnv = process.env): RecruitmentBackgroundModel | null {
  if (env.OTTO_ENTERPRISE_CANARY_MODE?.trim()) return null;
  const organizations = (env['OTTO_RECRUITMENT_MODEL_ORGANIZATION_IDS'] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const key = env['OTTO_RECRUITMENT_MODEL_API_KEY']; const model = env['OTTO_RECRUITMENT_MODEL']; const approval = env['OTTO_RECRUITMENT_MODEL_APPROVAL'];
  if (env['OTTO_RECRUITMENT_BACKGROUND_ANALYSIS_ENABLED'] !== '1' || !organizations.includes(organizationId) || !key || !model || !approval) return null;
  let url: URL;
  try { url = new URL(env['OTTO_RECRUITMENT_MODEL_API_URL'] ?? ''); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const version = createHash('sha256').update(JSON.stringify([url.href, model, approval, RECRUITMENT_SEMANTIC_ANALYSIS_VERSION])).digest('hex');
  return { id: model, version, organizationBudget: readRecruitmentOrganizationBudget(organizationId, env) ?? undefined, invoke: async (prompt, signal) => {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 4096 }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('招聘模型请求未完成'); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength; if (bytes > 1_000_000) throw new Error('招聘模型返回超过上限'); chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    const choice = data.choices?.[0];
    if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new Error('招聘模型结果不完整');
    const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    return { raw: choice.message.content, inputTokens: count(data.usage?.prompt_tokens), outputTokens: count(data.usage?.completion_tokens) };
  } };
}
