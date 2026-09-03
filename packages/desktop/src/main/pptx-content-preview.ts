/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import * as path from 'node:path';
import type { LocalArtifactPreviewSlide } from './local-artifact-preview.js';

const MAX_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 40 * 1024 * 1024;

/** No extraction to disk. Enforce the actual inflated size while streaming. */
async function readEntry(
  zip: JSZip,
  name: string,
  limit: number,
): Promise<Buffer> {
  const entry = zip.file(name);
  if (!entry) throw new Error('PPTX part is missing');
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', (data: Buffer) => {
      size += data.length;
      if (size > limit) {
        stream.pause();
        chunks.length = 0;
        reject(new Error('PPTX expanded size limit exceeded'));
        return;
      }
      chunks.push(data);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.resume();
  });
}

function xml(data: Buffer): Document {
  const source = data.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/iu.test(source))
    throw new Error('DTD and entities are not supported');
  let invalid = false;
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {
        invalid = true;
      },
      error: () => {
        invalid = true;
      },
      fatalError: () => {
        invalid = true;
      },
    },
  }).parseFromString(source, 'application/xml');
  if (
    invalid ||
    !doc.documentElement ||
    doc.getElementsByTagName('*').length > 30000
  )
    throw new Error('Invalid or oversized PPTX XML');
  return doc as unknown as Document;
}

function elements(doc: Document | Element, localName: string): Element[] {
  return Array.from(doc.getElementsByTagName('*')).filter(
    (node) => node.localName === localName,
  );
}
function relId(node: Element): string {
  return (
    Array.from(node.attributes).find(
      (attribute) => attribute.localName === 'id' && attribute.prefix,
    )?.value ?? ''
  );
}
function relations(doc: Document, base: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const node of elements(doc, 'Relationship')) {
    const target = node.getAttribute('Target') ?? '';
    if (
      node.getAttribute('TargetMode')?.toLowerCase() === 'external' ||
      /[\\:%?#]/u.test(target) ||
      target.startsWith('/')
    )
      continue;
    const normalized = path.posix.normalize(path.posix.join(base, target));
    if (!normalized.startsWith('ppt/') || normalized.includes('../')) continue;
    result.set(node.getAttribute('Id') ?? '', normalized);
  }
  return result;
}
function escape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}
function rasterMime(data: Buffer): string | undefined {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return 'image/jpeg';
  if (
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

/** Read-only content fallback, deliberately not a layout-faithful Office renderer.
 * Ignores macros, OLE, scripts, embedded SVG and all external relationships. */
export async function renderPptxContent(
  buffer: Buffer,
): Promise<LocalArtifactPreviewSlide[]> {
  if (buffer.length > MAX_ZIP_BYTES)
    throw new Error('PPTX archive is too large');
  const zip = await JSZip.loadAsync(buffer);
  if (Object.keys(zip.files).length > 4000)
    throw new Error('PPTX entry limit exceeded');
  let total = 0;
  const read = async (name: string, limit = MAX_XML_BYTES): Promise<Buffer> => {
    const result = await readEntry(
      zip,
      name,
      Math.min(limit, MAX_EXPANDED_BYTES - total),
    );
    total += result.length;
    return result;
  };
  const presentation = xml(await read('ppt/presentation.xml'));
  const presentationRels = relations(
    xml(await read('ppt/_rels/presentation.xml.rels')),
    'ppt',
  );
  const ids = elements(presentation, 'sldId');
  if (!ids.length || ids.length > 80)
    throw new Error('PPTX slide limit exceeded');
  const slides: LocalArtifactPreviewSlide[] = [];
  for (const id of ids) {
    const slidePath = presentationRels.get(relId(id));
    if (!slidePath?.startsWith('ppt/slides/'))
      throw new Error('Invalid slide relationship');
    const slide = xml(await read(slidePath));
    const paragraphs = elements(slide, 'p')
      .map((paragraph) =>
        elements(paragraph, 't')
          .map((t) => t.textContent ?? '')
          .join(''),
      )
      .filter(Boolean);
    const lines = paragraphs.flatMap((paragraph) => {
      const chars = Array.from(paragraph);
      return Array.from({ length: Math.ceil(chars.length / 50) }, (_, index) =>
        chars.slice(index * 50, (index + 1) * 50).join(''),
      );
    });
    if (lines.length > 160) throw new Error('PPTX text limit exceeded');
    const svgParts = lines.map(
      (line, index) =>
        `<text x="40" y="${80 + index * 30}" font-size="${index === 0 ? 25 : 20}" fill="#182333">${escape(line)}</text>`,
    );
    let imageY = 110 + lines.length * 30;
    const relsPath = path.posix.join(
      path.posix.dirname(slidePath),
      '_rels',
      `${path.posix.basename(slidePath)}.rels`,
    );
    const slideRels = zip.file(relsPath)
      ? relations(xml(await read(relsPath)), path.posix.dirname(slidePath))
      : new Map<string, string>();
    const blips = elements(slide, 'blip');
    if (blips.length > 40) throw new Error('PPTX image limit exceeded');
    for (const blip of blips) {
      const embedded = Array.from(blip.attributes).find(
        (attr) => attr.localName === 'embed',
      )?.value;
      const imagePath = embedded ? slideRels.get(embedded) : undefined;
      if (!imagePath?.startsWith('ppt/media/')) continue;
      const image = await read(imagePath, MAX_IMAGE_BYTES);
      const mime = rasterMime(image);
      if (!mime) continue;
      svgParts.push(
        `<image x="40" y="${imageY}" width="920" height="360" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${image.toString('base64')}"/>`,
      );
      imageY += 380;
    }
    if (!svgParts.length)
      svgParts.push(
        '<text x="40" y="100" font-size="24">此页没有可提取的文字或静态图片，可能包含图表或其他复杂对象。</text>',
      );
    const height = Math.max(562, imageY + 30);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}"><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif">${svgParts.join('')}</g></svg>`;
    slides.push({
      number: slides.length + 1,
      fileName: path.posix.basename(slidePath),
      dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    });
  }
  return slides;
}
