/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

export interface RecruitmentResumeExtraction {
  text: string;
  format: 'pdf' | 'txt';
  pages?: number;
  completeness: 'full_text' | 'partial' | 'unavailable';
}
export const RECRUITMENT_RESUME_MAX_BYTES = 8 * 1024 * 1024;
const failure = (): never => { throw new Error('简历解析失败、不支持该格式或超出安全上限，请手动补充文本材料'); };
let activePdfWorkers = 0;

// Static code only. Document bytes are workerData, never script or filesystem paths.
// Resource isolation is not an OS security sandbox; PDF scripts/eval and external fetching are disabled.
const PDF_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  let document;
  try {
    let hadWarning = false;
    // PDF.js reports skipped images and recovered parsing errors through console.
    // Do not decode images (including decompression bombs), or mistake a recovered page for complete text.
    console.log = console.warn = console.error = () => { hadWarning = true; };
    const parser = require(workerData.parserPath);
    parser.disableWorker = true;
    document = await parser.getDocument({ data: new Uint8Array(workerData.bytes), isEvalSupported: false, disableFontFace: true, disableAutoFetch: true, stopAtErrors: true, maxImageSize: 0 }).promise;
    if (!document || document.numPages < 1 || document.numPages > 40) throw new Error('limit');
    const imageOps = new Set(['paintJpegXObject', 'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageMaskXObjectGroup', 'paintInlineImageXObjectGroup', 'paintImageXObjectRepeat', 'paintImageMaskXObjectRepeat'].map(key => parser.OPS[key]));
    const pages = [];
    let partial = false;
    let characters = 0;
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const ops = await page.getOperatorList();
      const content = await page.getTextContent({ normalizeWhitespace: true });
      const text = content.items.map(item => typeof item.str === 'string' ? item.str : '').join(' ').trim();
      if (text.length < 20 || text.includes('\uFFFD') || ops.fnArray.some(op => imageOps.has(op))) partial = true;
      const entry = '[第 ' + n + ' 页]\n' + text;
      characters += entry.length + 2;
      if (characters > 80000) throw new Error('limit');
      pages.push({ text, entry });
    }
    const hasText = pages.some(page => page.text.length > 0);
    parentPort.postMessage({ ok: true, text: hasText ? pages.map(page => page.entry).join('\n\n') : '', format: 'pdf', pages: document.numPages, completeness: !hasText ? 'unavailable' : partial || hadWarning ? 'partial' : 'full_text' });
  } catch { parentPort.postMessage({ ok: false }); }
  finally { try { await document?.destroy(); } catch {} }
})();
`;

export async function extractRecruitmentResume(bytes: Buffer, contentType: string, signal: AbortSignal): Promise<RecruitmentResumeExtraction> {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > RECRUITMENT_RESUME_MAX_BYTES) return failure();
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const isPdf = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (!isPdf) {
    if (mime !== 'text/plain') return failure();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/gu, '\n').trim(); } catch { return failure(); }
    if (text.length > 80_000 || text.includes('\0') || /<(?:!doctype\s+html|html|script|body)\b/iu.test(text)) return failure();
    return { text, format: 'txt', completeness: !text ? 'unavailable' : text.length < 20 || text.includes('\uFFFD') ? 'partial' : 'full_text' };
  }
  if (!['application/pdf', 'application/octet-stream'].includes(mime) || !/%%EOF\s*$/u.test(bytes.subarray(-1024).toString('latin1'))) return failure();
  if (activePdfWorkers >= 2) throw new Error('简历解析繁忙，请稍后重试');
  activePdfWorkers++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  try {
    worker = new Worker(PDF_WORKER, {
      eval: true, workerData: { bytes, parserPath: createRequire(import.meta.url).resolve('pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js') },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true,
    });
    worker.stdout.resume(); worker.stderr.resume();
    return await new Promise<RecruitmentResumeExtraction>((resolve, reject) => {
      const fail = (): void => { reject(new Error('简历解析失败或超时，请手动补充文本材料')); };
      onAbort = () => reject(new Error('已取消简历解析'));
      timer = setTimeout(fail, 8_000);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      worker!.once('error', fail);
      worker!.once('exit', fail);
      worker!.once('message', (message) => {
        if (signal.aborted) { onAbort(); return; }
        if (!message?.ok || typeof message.text !== 'string' || message.text.length > 80_000 || !['full_text', 'partial', 'unavailable'].includes(message.completeness)) { fail(); return; }
        resolve({ text: message.text, format: 'pdf', pages: message.pages, completeness: message.completeness });
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await worker?.terminate();
    activePdfWorkers--;
  }
}
