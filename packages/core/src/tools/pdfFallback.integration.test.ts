/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerateDocumentTool, ChromeHtmlToImageRenderer } from './generate-document.js';
import { exportEditedDocument } from '../utils/editableDocument.js';
import { createMockConfig } from '../utils/test-helpers.js';
import * as commands from '../services/documentCommand.js';

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
    expect(fs.readFileSync(out)).toEqual(pdf);
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
});
