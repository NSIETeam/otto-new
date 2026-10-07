/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDocumentCommand, type DocumentCommandRunner } from './documentCommand.js';

/** Host-owned optional capability. Core never imports Electron or desktop code. */
export function hasDesktopPdfRenderer(): boolean {
  return Boolean(process.env.OTTO_DESKTOP_PDF_EXECUTABLE
    && process.env.OTTO_DESKTOP_PDF_HELPER
    && fs.existsSync(process.env.OTTO_DESKTOP_PDF_HELPER));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(value: string): string {
  // Deliberately text-only: images/links cannot fetch remote or local resources.
  return escapeHtml(value)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
}

function blocks(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const result: string[] = [];
  let list = '';
  const endList = () => { if (list) result.push(`</${list}>`); list = ''; };
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      endList();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      result.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      endList();
      const headings = cells(line);
      result.push('<table><thead><tr>' + headings.map((cell) => `<th>${inline(cell.trim())}</th>`).join('') + '</tr></thead><tbody>');
      i++;
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
        const row = cells(lines[++i]);
        result.push('<tr>' + headings.map((_, c) => `<td>${inline((row[c] ?? '').trim())}</td>`).join('') + '</tr>');
      }
      result.push('</tbody></table>');
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (bullet) {
      const next = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== next) { endList(); result.push(`<${next}>`); list = next; }
      result.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    endList();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) result.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    else if (/^\s*---\s*$/.test(line)) result.push('<hr>');
    else if (/^>\s?/.test(line)) result.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    else if (line.trim()) result.push(`<p>${inline(line)}</p>`);
  }
  endList();
  return result.join('\n');
}

export interface DesktopPdfRequest {
  content: string;
  outputPath: string;
  title?: string;
  byline?: string;
  layout?: 'document' | 'slides';
  signal?: AbortSignal;
}

export function buildBasicPdfHtml(request: DesktopPdfRequest): string {
  const slides = request.layout === 'slides';
  const title = request.title ? `<h1 class="document-title">${escapeHtml(request.title)}</h1>` : '';
  const byline = request.byline ? `<p class="byline">${escapeHtml(request.byline)}</p>` : '';
  const body = slides
    ? request.content.replace(/\r\n?/g, '\n').split(/^\s*---\s*$/m)
      .map((section) => `<section class="slide">${blocks(section)}</section>`).join('\n')
    : `${title}${byline}${blocks(request.content)}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(request.title ?? 'Otto PDF')}</title><style>
@page { size: ${slides ? '320mm 180mm' : 'A4'}; margin: ${slides ? '12mm' : '20mm'}; }
* { box-sizing: border-box; } body { margin: 0; color: #202938; font-family: 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif; font-size: ${slides ? '18pt' : '11pt'}; line-height: 1.65; overflow-wrap: anywhere; }
h1,h2,h3,h4,h5,h6 { color: #193a5c; line-height: 1.3; break-after: avoid; } h1 { font-size: 22pt; } h2 { font-size: 16pt; }
p { margin: 0 0 0.7em; } .byline { color: #596579; font-size: 10pt; } table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 1em 0; font-size: 10pt; }
th,td { border: 1px solid #b9c3d0; padding: 6px 8px; vertical-align: top; } th { background: #eef2f7; } thead { display: table-header-group; } tr { break-inside: avoid; }
pre { white-space: pre-wrap; font-size: 9pt; border: 1px solid #cbd5e1; padding: 10px; } code { font-family: Consolas, monospace; } blockquote { border-left: 3px solid #7b91ac; margin-left: 0; padding-left: 1em; } li { margin-bottom: 0.3em; }
.slide { break-after: page; } .slide:last-child { break-after: auto; }
</style></head><body>${body}</body></html>`;
}

export function assertCompletePdf(file: string): void {
  const data = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))
    || !/%%EOF\s*$/.test(data.subarray(-1024).toString('latin1'))) {
    throw new Error('PDF 渲染器未产出完整 PDF；原文件未修改。');
  }
}

/** Only system essentials, never credentials, customer settings or user profiles. */
function rendererEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

export async function renderDesktopPdf(
  request: DesktopPdfRequest,
  runner: DocumentCommandRunner = runDocumentCommand,
): Promise<void> {
  if (!hasDesktopPdfRenderer()) throw new Error('内置 PDF 渲染器不可用，请升级或配置文档引擎。');
  const signal = request.signal ?? new AbortController().signal;
  if (signal.aborted) throw new Error('PDF 生成已取消');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-pdf-'));
  try {
    const html = path.join(temp, 'document.html');
    const pdf = path.join(temp, 'document.pdf');
    fs.writeFileSync(html, buildBasicPdfHtml(request), { mode: 0o600, flag: 'wx' });
    await runner(process.env.OTTO_DESKTOP_PDF_EXECUTABLE!,
      [process.env.OTTO_DESKTOP_PDF_HELPER!, html, pdf, path.join(temp, 'profile')],
      { env: rendererEnvironment(), signal, timeout: 45_000 });
    if (signal.aborted) throw new Error('PDF 生成已取消');
    assertCompletePdf(pdf);
    fs.copyFileSync(pdf, request.outputPath);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      .catch(() => undefined); // Disposable staging; do not replace the real error.
  }
}
