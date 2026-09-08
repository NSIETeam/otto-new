/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import {
  inspectArtifactFile,
  inspectPdfFile,
  readVersionedFile,
  sameFileVersion,
} from './artifactEvidence.js';
const dirs: string[] = [];
function output(name: string, bytes: Buffer | string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-artifact-proof-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { force: true, recursive: true })),
);

async function pptx() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  );
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
  );
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Evidence</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  );
  return zip;
}
it('validates full ZIP contents and XML of a PPTX, then binds the exact bytes', async () => {
  const file = output(
    'slides.pptx',
    await (await pptx()).generateAsync({ type: 'nodebuffer' }),
  );
  const receipt = inspectArtifactFile(file, 'generator');
  expect(receipt.status).toBe('verified');
  expect(receipt.version?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    sameFileVersion(receipt.version, readVersionedFile(file)?.version),
  ).toBe(true);
});
it.each([
  'corrupt',
  'truncated',
  'missing-main',
  'invalid-xml',
  'missing-slide',
  'blank-slide',
  'dangling-relationship',
  'wrong-content-type',
  'missing-slide-reference',
] as const)('rejects a %s PPTX', async (failure) => {
  const zip = await pptx();
  if (failure === 'dangling-relationship')
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/absent.xml"/></Relationships>',
    );
  if (failure === 'wrong-content-type')
    zip.file(
      '[Content_Types].xml',
      '<Types><Override PartName="/ppt/presentation.xml" ContentType="text/plain"/></Types>',
    );
  if (failure === 'missing-slide-reference')
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    );
  if (failure === 'missing-main') zip.remove('ppt/presentation.xml');
  if (failure === 'invalid-xml')
    zip.file('ppt/presentation.xml', '<p:presentation>');
  if (failure === 'missing-slide') zip.remove('ppt/slides/slide1.xml');
  if (failure === 'blank-slide')
    zip.file(
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>',
    );
  let bytes = await zip.generateAsync({ type: 'nodebuffer' });
  if (failure === 'corrupt') bytes[bytes.indexOf(Buffer.from('Evidence'))] ^= 1;
  if (failure === 'truncated') bytes = bytes.subarray(0, bytes.length - 20);
  expect(
    inspectArtifactFile(output('broken.pptx', bytes), 'generator').status,
  ).toBe('format_mismatch');
});
it('rejects ambiguous ZIP names, missing bytes and invalid JSON', async () => {
  const zip = new JSZip();
  zip.file('../escape.txt', 'bad');
  expect(
    inspectArtifactFile(
      output('escape.zip', await zip.generateAsync({ type: 'nodebuffer' })),
      'write',
    ).status,
  ).not.toBe('verified');
  expect(inspectArtifactFile(output('empty.json', ''), 'write').status).toBe(
    'empty',
  );
  expect(
    inspectArtifactFile(output('bad.json', '{"unterminated":'), 'write').status,
  ).toBe('format_mismatch');
});
it('marks formats without a decoder unsupported rather than falsely verified or corrupt', () => {
  expect(
    inspectArtifactFile(
      output('image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'write',
    ).status,
  ).toBe('unsupported');
});
it('parses a real PDF without opening a viewer, and rejects a header-only fake', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = 'BT /F1 12 Tf 10 100 Td (Evidence) Tj ET\n';
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
      .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const file = output('report.pdf', pdf);
  expect(
    (await inspectPdfFile(file, inspectArtifactFile(file, 'write'))).status,
  ).toBe('verified');
  const fake = output('fake.pdf', '%PDF-1.4\n%%EOF');
  expect(
    (await inspectPdfFile(fake, inspectArtifactFile(fake, 'write'))).status,
  ).toBe('format_mismatch');
});
