/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerateDocumentTool, ChromeHtmlToImageRenderer } from './generate-document.js';
import { exportEditedDocument } from '../utils/editableDocument.js';
import { createMockConfig } from '../utils/test-helpers.js';
import * as commands from '../services/documentCommand.js';
import { renderDesktopPdf } from '../services/desktopPdf.js';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
let root: string;
let runner: ReturnType<typeof vi.fn>;
let html: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-pdf-fallback-'));
  const helper = path.join(root, 'pdf-renderer.js');
  fs.writeFileSync(helper, '// synthetic host helper presence');
  vi.stubEnv('OTTO_DESKTOP_PDF_EXECUTABLE', '/trusted desktop/Otto.exe');
  vi.stubEnv('OTTO_DESKTOP_PDF_HELPER', helper);
  html = [];
  runner = vi.fn(async (_exe: string, args: string[]) => {
    html.push(fs.readFileSync(args[1], 'utf8'));
    fs.writeFileSync(args[2], pdf);
  });
  vi.spyOn(commands, 'runDocumentCommand').mockImplementation(runner);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
const tool = () => new GenerateDocumentTool(
  createMockConfig({ getDocumentIdentity: () => ({ name: '林一', department: '研发部' }) }),
  new ChromeHtmlToImageRenderer(null), runner,
  async () => 'Typst/Pandoc unavailable',
);

describe('bundled desktop PDF fallback', () => {
  it.each(['report', 'article', 'letter', 'resume', 'table'] as const)(
    'generates %s PDF without Typst/Pandoc and discloses the basic layout', async (format) => {
      const out = path.join(root, `${format}.pdf`);
      for (let round = 0; round < 5; round++) {
        const result = await tool().execute({
          content: '# 中文正文\n\n支持 **中文** 与 English。\n\n| 能力 | 结果 |\n| --- | --- |\n| PDF | 可回查 |',
          title: '验收报告', author: 'untrusted-author', format,
          output_format: 'pdf', output_path: out,
        }, new AbortController().signal);
        expect(result.llmContent).toContain('generate_document OK');
        expect(result.returnDisplay).toContain('内置 PDF 基础排版');
        expect(fs.readFileSync(out)).toEqual(pdf);
      }
      expect(html).toHaveLength(5);
      expect(html[0]).toContain('验收报告');
      expect(html[0]).toContain('研发部 · 林一');
      expect(html[0]).not.toContain('untrusted-author');
      expect(html[0]).toContain('<table>');
      expect(html[0]).toContain('<strong>中文</strong>');
      expect(html[0]).toContain('@page');
    },
  );

  it('exports edited PDF through the same bundled path without Python', async () => {
    const out = path.join(root, 'edited.pdf');
    const result = await exportEditedDocument(out, '# 修订稿\n\n中文段落', out);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(out).equals(pdf)).toBe(true);
    expect(runner).toHaveBeenCalledOnce();
    expect(html[0]).toContain('修订稿');
  });

  it('escapes active HTML and does not load remote/local images or links', async () => {
    await tool().execute({
      format: 'article', output_format: 'pdf', output_path: path.join(root, 'safe.pdf'),
      title: '<script>secret()</script>',
      content: '<script>fetch("https://example.invalid")</script>\n\n![秘密](file:///etc/passwd)\n\n[外链](https://example.invalid)\n\n```html\n<img src="https://example.invalid">\n```',
    }, new AbortController().signal);
    expect(html[0]).not.toMatch(/<script|<img|<iframe|<a\s/i);
    expect(html[0]).toContain('&lt;script&gt;');
    expect(html[0]).toContain("default-src 'none'");
    expect(html[0]).toContain('秘密');
  });

  it('uses structured argv, a private profile and a credential-free child environment', async () => {
    vi.stubEnv('SYNTHETIC_TEST_SECRET', 'never-forward-this');
    await tool().execute({ content: 'body', format: 'article', output_format: 'pdf',
      output_path: path.join(root, '中文 & report.pdf') }, new AbortController().signal);
    const [exe, args, options] = runner.mock.calls[0];
    expect(exe).toBe('/trusted desktop/Otto.exe');
    expect(args).toHaveLength(4);
    expect(args[0]).toBe(process.env.OTTO_DESKTOP_PDF_HELPER);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.env.SYNTHETIC_TEST_SECRET).toBeUndefined();
    expect(options.env.OTTO_USER_DIR).toBeUndefined();
    expect(options.timeout).toBeLessThanOrEqual(60_000);
  });

  it.each(['empty', 'html', 'truncated', 'error'])(
    'rejects %s output and preserves the previous document', async (mode) => {
      const out = path.join(root, 'previous.pdf');
      fs.writeFileSync(out, 'previous user document');
      runner.mockImplementationOnce(async (_exe: string, args: string[]) => {
        if (mode === 'error') throw new Error('printer failed');
        fs.writeFileSync(args[2], mode === 'empty' ? '' : mode === 'html' ? '<html>not pdf</html>' : '%PDF-1.7\ntruncated');
      });
      await expect(tool().execute({ content: 'body', format: 'article', output_format: 'pdf', output_path: out },
        new AbortController().signal)).rejects.toThrow();
      expect(fs.readFileSync(out, 'utf8')).toBe('previous user document');
    },
  );

  it('never publishes PDF when cancellation arrives during printing', async () => {
    const controller = new AbortController();
    const out = path.join(root, 'cancelled.pdf');
    runner.mockImplementationOnce(async (_exe: string, args: string[]) => {
      fs.writeFileSync(args[2], pdf);
      controller.abort(new Error('user cancelled'));
    });
    await expect(tool().execute({ content: 'body', format: 'article', output_format: 'pdf', output_path: out },
      controller.signal)).rejects.toThrow(/cancel|取消/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('preserves an edited PDF when the renderer fails', async () => {
    const out = path.join(root, 'edit-failure.pdf');
    fs.writeFileSync(out, 'previous user document');
    runner.mockRejectedValueOnce(new Error('printer failed'));
    await expect(exportEditedDocument(out, '# edit', out)).rejects.toThrow();
    expect(fs.readFileSync(out, 'utf8')).toBe('previous user document');
  });

  it('does not truncate an existing edited PDF when staging copy fails', async () => {
    const out = path.join(root, 'disk-full.pdf');
    fs.writeFileSync(out, 'previous user document');
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => { throw new Error('synthetic disk full'); });
    await expect(exportEditedDocument(out, '# edit', out)).rejects.toThrow('disk full');
    expect(fs.readFileSync(out, 'utf8')).toBe('previous user document');
    copy.mockRestore();
  });

  it('falls back for slide PDF without Marp, with explicit page breaks', async () => {
    const result = await tool().execute({ content: '# 第一页\n介绍\n\n---\n\n# 第二页\n结论',
      format: 'slides', output_format: 'pdf', output_path: path.join(root, 'slides.pdf') },
    new AbortController().signal);
    expect(result.returnDisplay).toContain('内置 PDF 基础排版');
    expect(html[0].match(/class="slide"/g)).toHaveLength(2);
    expect(html[0]).toContain('320mm 180mm');
  });

  it('does not start printing after cancellation during engine preflight', async () => {
    const controller = new AbortController();
    const cancelled = new GenerateDocumentTool(createMockConfig(), new ChromeHtmlToImageRenderer(null), runner,
      async () => { controller.abort(); return 'missing'; });
    await expect(cancelled.execute({ content: 'body', format: 'article', output_format: 'pdf',
      output_path: path.join(root, 'not-started.pdf') }, controller.signal)).rejects.toThrow('取消');
    expect(runner).not.toHaveBeenCalled();
  });

  it('renders lists, quotations and literal fenced code without active markup', async () => {
    await renderDesktopPdf({ outputPath: path.join(root, 'syntax.pdf'),
      content: '# 标题\n\n1. 编号\n2) 第二项\n\n- 无序\n\n> 引用\n\n---\n\n```html\n<div>纯文本</div>\n```\n\n## 小节\n**强调**与 *斜体*\n\n```\n未闭合代码块' }, runner);
    expect(html[0]).toContain('<ol>');
    expect(html[0]).toContain('<ul>');
    expect(html[0]).toContain('<blockquote>');
    expect(html[0]).toContain('<hr>');
    expect(html[0]).toContain('&lt;div&gt;纯文本&lt;/div&gt;');
    expect(html[0]).toContain('<em>斜体</em>');
    expect(html[0]).toContain('未闭合代码块');
  });

  it('rejects missing host capability and an already cancelled request without starting a child', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(renderDesktopPdf({ content: 'body', outputPath: path.join(root, 'none.pdf'), signal: controller.signal }, runner)).rejects.toThrow('取消');
    vi.stubEnv('OTTO_DESKTOP_PDF_HELPER', '');
    await expect(renderDesktopPdf({ content: 'body', outputPath: path.join(root, 'none.pdf') }, runner)).rejects.toThrow('不可用');
    expect(runner).not.toHaveBeenCalled();
  });

  it('preserves an existing PDF when cancelled after staging but before publication', async () => {
    const out = path.join(root, 'publish-cancelled.pdf');
    fs.writeFileSync(out, 'previous user document');
    const controller = new AbortController();
    const copy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce((from, to, mode) => {
      copy(from, to, mode); controller.abort();
    });
    await expect(renderDesktopPdf({ content: 'body', outputPath: out, signal: controller.signal }, runner)).rejects.toThrow('取消');
    expect(fs.readFileSync(out, 'utf8')).toBe('previous user document');
    expect(fs.readdirSync(root).some((file) => file.startsWith('.otto-pdf-publish-'))).toBe(false);
  });
});
