/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import type { Config } from '../config/config.js';
import {
  GenerateSafeDocumentTool,
  type SafeDocumentParams,
} from './generate-safe-document.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-safe-document-'));
  roots.push(root);
  const tool = new GenerateSafeDocumentTool({
    getTargetDir: () => root,
  } as Config);
  const params: SafeDocumentParams = {
    file_path: path.join(root, '交付.pptx'),
    title: '工作报告',
    slides: [
      {
        title: '结果',
        body: '用户数据仅作为文字。<script>open("WPS")</script>',
      },
    ],
  };
  return { root, tool, params };
}
it('uses a host-selected ancestor alias but rejects nested links and later root retargeting', async () => {
  const { root, params } = setup();
  const physical = path.join(root, 'physical');
  const other = path.join(root, 'other');
  mkdirSync(path.join(physical, 'workspace'), { recursive: true });
  mkdirSync(path.join(other, 'workspace'), { recursive: true });
  const alias = path.join(root, 'alias');
  symlinkSync(physical, alias, 'junction');
  const selected = path.join(alias, 'workspace');
  const tool = new GenerateSafeDocumentTool({ getTargetDir: () => selected } as Config);
  const input = { ...params, file_path: path.join(selected, 'alias.pptx') };
  expect(tool.validateToolParams(input)).toBeNull();
  await tool.execute(input, new AbortController().signal);
  const zip = await JSZip.loadAsync(readFileSync(path.join(physical, 'workspace/alias.pptx')));
  expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('结果');
  symlinkSync(other, path.join(physical, 'workspace/escape'), 'junction');
  expect(tool.validateToolParams({ ...input, file_path: path.join(selected, 'escape/outside.pptx') })).not.toBeNull();
  unlinkSync(alias);
  symlinkSync(other, alias, 'junction');
  expect(tool.validateToolParams({ ...input, file_path: path.join(selected, 'changed.pptx') })).not.toBeNull();
});
it('generates a real PPTX containing literal user text without executable or remote relationships', async () => {
  const { tool, params } = setup();
  await tool.execute(params, new AbortController().signal);
  const zip = await JSZip.loadAsync(readFileSync(params.file_path));
  expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain(
    '&lt;script&gt;',
  );
  expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain(
    '结果',
  );
  for (const entry of Object.values(zip.files).filter((e) =>
    /\.rels$/.test(e.name),
  ))
    expect(await entry.async('string')).not.toMatch(
      /TargetMode="External"|vbaProject/i,
    );
  expect(
    Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name),
  ).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/vbaProject|embeddings/)]),
  );
});
it('revalidates the bound root after asynchronous rendering before writing any bytes', async () => {
  const { root, params } = setup();
  const physical = path.join(root, 'physical');
  const other = path.join(root, 'other');
  mkdirSync(physical);
  mkdirSync(other);
  const alias = path.join(root, 'alias');
  symlinkSync(physical, alias, 'junction');
  const tool = new GenerateSafeDocumentTool({ getTargetDir: () => alias } as Config);
  const pending = tool.execute({ ...params, file_path: path.join(alias, 'pending.pptx') }, new AbortController().signal);
  // execute validated synchronously, then yielded at the lazy renderer import.
  unlinkSync(alias);
  symlinkSync(other, alias, 'junction');
  await expect(pending).rejects.toThrow();
  expect(existsSync(path.join(physical, 'pending.pptx'))).toBe(false);
  expect(existsSync(path.join(other, 'pending.pptx'))).toBe(false);
});
it('rejects scripts, remote assets, unsupported formats, oversize inputs and out-of-workspace writes', async () => {
  const { tool, params, root } = setup();
  for (const invalid of [
    { ...params, script: 'print(1)' },
    { ...params, template_url: 'https://example.com/a' },
    { ...params, file_path: path.join(root, 'a.pdf') },
    { ...params, file_path: path.join(root, '..', 'outside.pptx') },
    { ...params, slides: [{ title: 'x', body: 'x'.repeat(10000) }] },
    {
      ...params,
      slides: [{ title: 'x', body: 'x', image: 'https://example.com/a.png' }],
    },
  ])
    await expect(
      tool.execute(invalid as SafeDocumentParams, new AbortController().signal),
    ).rejects.toThrow();
});
it('never overwrites an existing file or follows a directory junction; cancelled generation writes nothing', async () => {
  const { tool, params, root } = setup();
  writeFileSync(params.file_path, 'preserved');
  await expect(
    tool.execute(params, new AbortController().signal),
  ).rejects.toThrow();
  expect(readFileSync(params.file_path, 'utf8')).toBe('preserved');
  mkdirSync(path.join(root, 'real'));
  symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), 'junction');
  await expect(
    tool.execute(
      { ...params, file_path: path.join(root, 'linked', 'a.pptx') },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    tool.execute(
      { ...params, file_path: path.join(root, 'cancelled.pptx') },
      cancelled.signal,
    ),
  ).rejects.toThrow();
});
