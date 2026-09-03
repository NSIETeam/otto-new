/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderPptxContent } from './pptx-content-preview.js';
import { buildLocalArtifactPreview } from './local-artifact-preview.js';

async function deck(extra = '', external = false): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="b"/><p:sldId r:id="a"/></p:sldIdLst></p:presentation>',
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
  );
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>First &lt;script&gt;</a:t></a:r></a:p></p:sld>',
  );
  zip.file(
    'ppt/slides/slide2.xml',
    `${extra}<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><a:p><a:r><a:t>Second</a:t></a:r></a:p><a:blip r:embed="img"/></p:sld>`,
  );
  zip.file(
    'ppt/slides/_rels/slide2.xml.rels',
    `<Relationships><Relationship Id="img" Target="${external ? 'https://example.com/tracker.png' : '../media/a.png'}"${external ? ' TargetMode="External"' : ''}/></Relationships>`,
  );
  zip.file('ppt/media/a.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
describe('offline PPTX content preview', () => {
  it.each([false, true])(
    'opens through the app preview API without trusted sidecars (ambiguous decks: %s)',
    async (ambiguous) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'otto-pptx-fallback-test-'),
      );
      try {
        const file = path.join(directory, 'current.pptx');
        await writeFile(file, await deck());
        if (ambiguous) {
          await writeFile(path.join(directory, 'another.pptx'), await deck());
          await mkdir(path.join(directory, 'shots'));
          await writeFile(
            path.join(directory, 'shots', 'wrong.png'),
            'unrelated deck',
          );
        }
        const preview = await buildLocalArtifactPreview(file);
        expect(preview.ok).toBe(true);
        expect(preview.notice).toContain('内容预览');
        expect(preview.slides).toHaveLength(2);
        expect(preview.slides[0].dataUrl).toMatch(
          /^data:image\/svg\+xml;base64,/u,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it('renders a deck without sidecars in presentation order and escapes user XML text', async () => {
    const slides = await renderPptxContent(await deck());
    expect(slides).toHaveLength(2);
    const svg = (i: number) =>
      Buffer.from(slides[i].dataUrl.split(',')[1], 'base64').toString();
    expect(svg(0)).toContain('Second');
    expect(svg(0)).toContain('data:image/png;base64,');
    expect(svg(1)).toContain('&lt;script&gt;');
    expect(svg(1)).not.toContain('<script>');
  });
  it('never resolves external relationships', async () => {
    const slides = await renderPptxContent(await deck('', true));
    const svg = Buffer.from(
      slides[0].dataUrl.split(',')[1],
      'base64',
    ).toString();
    expect(svg).not.toContain('https://');
    expect(svg).not.toContain('data:image/png');
  });
  it('rejects DTD/entity payloads and malformed archives', async () => {
    await expect(
      renderPptxContent(
        await deck('<!DOCTYPE p [<!ENTITY x SYSTEM "file:///etc/passwd">]>'),
      ),
    ).rejects.toThrow();
    await expect(renderPptxContent(Buffer.from('not a zip'))).rejects.toThrow();
  });
  it('caps actual inflated bytes, not just the claimed file size', async () => {
    await expect(
      renderPptxContent(await deck(' '.repeat(3 * 1024 * 1024))),
    ).rejects.toThrow(/limit|large/i);
  });
});
