/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { pinnedEndpointDispatcher, resolvePublicMcpEndpoint } from '../../mcpManagement.js';
import { RecruitmentSourceUserError } from './recruitmentSourceGateway.js';
import { normalizeRecruitmentMaterial, type RecruitmentCandidateMaterial } from './recruitmentSourceMaterial.js';
import { extractRecruitmentResume, RECRUITMENT_RESUME_MAX_BYTES } from './recruitmentResumeExtraction.js';

export type RecruitmentResumeReader = (input: {
  url: string;
  sourceRecordId: string;
  signal: AbortSignal;
  assertAuthorized(): Promise<void>;
}) => Promise<RecruitmentCandidateMaterial>;

function origin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new RecruitmentSourceUserError('简历来源配置无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
    || !/^[a-z0-9.-]+$/u.test(url.hostname) || !url.hostname.includes('.') || url.hostname.endsWith('.') || url.hostname.includes('*') || isIP(url.hostname)) throw new RecruitmentSourceUserError('简历来源必须是明确审核的 HTTPS 域名，不支持通配符');
  return url.origin;
}

export function validateRecruitmentResumeUrl(value: string, approvedOrigins: readonly string[]): URL {
  let url: URL;
  try { if (value.length > 8_192) throw new Error(); url = new URL(value); } catch { throw new RecruitmentSourceUserError('简历来源地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !approvedOrigins.map(origin).includes(url.origin)) throw new RecruitmentSourceUserError('简历来源未通过企业审核，请手动导入材料');
  return url;
}

export function createRecruitmentResumeReader(options: {
  approvedOrigins: readonly string[];
  /** Test/deployment DNS resolver; socket connection remains pinned to validated answers. */
  lookup?: Parameters<typeof resolvePublicMcpEndpoint>[1];
}): RecruitmentResumeReader {
  const approved = options.approvedOrigins.map(origin);
  let activeDownloads = 0;
  return async (input) => {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(12_000)]);
    const check = async (): Promise<void> => {
      signal.throwIfAborted();
      try { await input.assertAuthorized(); } catch { throw new RecruitmentSourceUserError('简历读取授权已失效，本次材料未入档'); }
      signal.throwIfAborted();
    };
    const url = validateRecruitmentResumeUrl(input.url, approved);
    if (activeDownloads >= 8) throw new RecruitmentSourceUserError('简历下载繁忙，请稍后重试');
    activeDownloads++;
    let dispatcher: ReturnType<typeof pinnedEndpointDispatcher> | undefined;
    let response: Response | undefined;
    try {
      await check();
      const endpoint = await resolvePublicMcpEndpoint(url, options.lookup);
      await check();
      dispatcher = pinnedEndpointDispatcher(endpoint);
      response = await fetch(url, {
        method: 'GET', redirect: 'error', credentials: 'omit', signal, dispatcher,
        headers: { Accept: 'application/pdf, text/plain, application/octet-stream', 'Accept-Encoding': 'identity' },
      } as RequestInit);
      await check();
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href) || response.headers.has('content-range')) throw new RecruitmentSourceUserError('简历下载未成功，请重试或手动导入');
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding !== 'identity') throw new RecruitmentSourceUserError('简历下载格式不受支持');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > RECRUITMENT_RESUME_MAX_BYTES)) throw new RecruitmentSourceUserError('简历附件过大或大小无效');
      const reader = response.body?.getReader();
      if (!reader) throw new RecruitmentSourceUserError('简历下载没有正文');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > RECRUITMENT_RESUME_MAX_BYTES) throw new RecruitmentSourceUserError('简历附件过大，未截断分析');
          chunks.push(chunk.value);
        }
      } finally { try { await reader.cancel(); } catch { /* Never expose upstream errors or signed URLs. */ } reader.releaseLock(); }
      if (!size || (declared !== null && Number(declared) !== size)) throw new RecruitmentSourceUserError('简历下载不完整，请重试');
      await check();
      const bytes = Buffer.concat(chunks);
      const extracted = await extractRecruitmentResume(bytes, response.headers.get('content-type') ?? '', signal);
      await check();
      return normalizeRecruitmentMaterial({
        sourceRecordId: input.sourceRecordId, fileName: `来源简历.${extracted.format}`, text: extracted.text, completeness: extracted.completeness,
        attachment: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: size, format: extracted.format, ...(extracted.pages ? { pages: extracted.pages } : {}), extractorVersion: 'otto-resume-v1' },
      }, input.sourceRecordId);
    } catch (error) {
      if (signal.aborted) throw new RecruitmentSourceUserError('简历下载或解析已取消或超时');
      if (error instanceof RecruitmentSourceUserError) throw error;
      throw new RecruitmentSourceUserError('简历安全下载或解析失败，请重试或手动导入完整简历');
    } finally {
      try { await response?.body?.cancel(); } catch { /* Reader may have consumed the body. */ }
      try { await dispatcher?.destroy(); } catch { /* Cleanup never leaks upstream errors. */ }
      finally { activeDownloads--; }
    }
  };
}
