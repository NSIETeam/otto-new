/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { crc32, inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import type { AgentArtifactReference } from './protocol.js';

export interface FileVersion {
  path: string;
  sha256: string;
  size: number;
  fileId: string;
}
export const MAX_EVIDENCE_FILE_BYTES = 32 * 1024 * 1024;
type Verification = NonNullable<AgentArtifactReference['verification']>;

/** Bounded local bytes, never a path/hash asserted in model output. */
export function readVersionedFile(
  file: string,
): { version: FileVersion; bytes: Buffer } | undefined {
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(file) || !lstatSync(file).isFile()) return;
    fd = openSync(file, 'r');
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_EVIDENCE_FILE_BYTES))
      return;
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    let count = 0;
    do {
      count = readSync(fd, buffer, size, buffer.length - size, null);
      size += count;
    } while (count && size < buffer.length);
    const bytes = buffer.subarray(0, size);
    const after = fstatSync(fd, { bigint: true });
    const currentPath = lstatSync(file, { bigint: true });
    if (
      before.size !== BigInt(bytes.length) ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !currentPath.isFile() ||
      currentPath.ino !== before.ino ||
      currentPath.dev !== before.dev
    )
      return;
    const resolved = realpathSync(file);
    return {
      bytes,
      version: {
        path: process.platform === 'win32' ? resolved.toLowerCase() : resolved,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        fileId: `${before.dev}:${before.ino}`,
      },
    };
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function sameFileVersion(a?: FileVersion, b?: FileVersion): boolean {
  return (
    !!a &&
    !!b &&
    a.path === b.path &&
    a.sha256 === b.sha256 &&
    a.size === b.size &&
    a.fileId === b.fileId
  );
}
export function observeFileBefore(file: string): {
  version?: FileVersion;
  absent: boolean;
} {
  const observed = readVersionedFile(file);
  if (observed) return { version: observed.version, absent: false };
  try {
    lstatSync(file);
  } catch (error) {
    return { absent: (error as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  return { absent: false };
}

function parseXml(bytes: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error('DTD not supported');
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
  }).parseFromString(text, 'text/xml');
  if (invalid || !doc.documentElement) throw new Error('Malformed XML');
  return doc;
}

function xmlRoot(bytes: Buffer): string {
  return parseXml(bytes).documentElement.localName;
}

function officePackageValid(
  entries: Map<string, Buffer>,
  ext: string,
): boolean {
  const main = {
    '.pptx': [
      'ppt/presentation.xml',
      'presentation',
      'presentationml.presentation',
    ],
    '.docx': ['word/document.xml', 'document', 'wordprocessingml.document'],
    '.xlsx': ['xl/workbook.xml', 'workbook', 'spreadsheetml.sheet'],
  }[ext]!;
  const docs = new Map(
    [...entries]
      .filter(([name]) => /\.(?:xml|rels)$/u.test(name))
      .map(([name, data]) => [name, parseXml(data)]),
  );
  const document = docs.get(main[0]);
  const types = docs.get('[Content_Types].xml');
  if (
    !document ||
    document.documentElement.localName !== main[1] ||
    types?.documentElement.localName !== 'Types'
  )
    return false;
  const overrides = Array.from(types.getElementsByTagNameNS('*', 'Override'));
  if (
    !overrides.some(
      (node) =>
        node.getAttribute('PartName') === `/${main[0]}` &&
        node.getAttribute('ContentType') ===
          `application/vnd.openxmlformats-officedocument.${main[2]}.main+xml`,
    )
  )
    return false;

  // Resolve relationships inside the package only. External links are never fetched.
  const relations = new Map<
    string,
    Map<string, { target: string; type: string }>
  >();
  for (const [name, doc] of docs) {
    if (!name.endsWith('.rels')) continue;
    if (doc.documentElement.localName !== 'Relationships') return false;
    const match = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/u.exec(name);
    const owner =
      name === '_rels/.rels'
        ? ''
        : match
          ? path.posix.join(match[1] || '', match[2])
          : undefined;
    if (owner === undefined || (owner && !entries.has(owner))) return false;
    const indexed = new Map<string, { target: string; type: string }>();
    const ids = new Set<string>();
    for (const node of Array.from(
      doc.getElementsByTagNameNS('*', 'Relationship'),
    )) {
      const id = node.getAttribute('Id');
      const type = node.getAttribute('Type');
      const raw = node.getAttribute('Target');
      if (!id || !type || !raw || ids.has(id)) return false;
      ids.add(id);
      if (node.getAttribute('TargetMode') === 'External') continue;
      const target = decodeURIComponent(raw.split('#')[0]);
      if (
        !target ||
        /[\\\0?]/u.test(target) ||
        /^[a-z][\w+.-]*:/iu.test(target)
      )
        return false;
      const resolved = path.posix.normalize(
        target.startsWith('/')
          ? target.slice(1)
          : path.posix.join(owner ? path.posix.dirname(owner) : '', target),
      );
      if (resolved.startsWith('../') || !entries.has(resolved)) return false;
      indexed.set(id, { target: resolved, type });
    }
    relations.set(owner, indexed);
  }
  if (
    ![...(relations.get('')?.values() || [])].some(
      (ref) => ref.type.endsWith('/officeDocument') && ref.target === main[0],
    )
  )
    return false;
  if (ext === '.pptx' || ext === '.xlsx') {
    const nodes = Array.from(
      document.getElementsByTagNameNS('*', ext === '.pptx' ? 'sldId' : 'sheet'),
    );
    const linked = relations.get(main[0]);
    if (
      !nodes.length ||
      nodes.some((node) => {
        const id = Array.from(node.attributes).find(
          (attr) =>
            attr.localName === 'id' &&
            attr.namespaceURI?.endsWith('/relationships'),
        )?.value;
        const ref = id ? linked?.get(id) : undefined;
        return (
          !ref || !ref.type.endsWith(ext === '.pptx' ? '/slide' : '/worksheet')
        );
      })
    )
      return false;
  }
  return true;
}

/** ZIP32 only: validate central/local bounds, names, sizes and every CRC without extracting to disk.
 * Unsupported encryption/ZIP64/compression fails closed. Bound expansion before inflating. */
export function zipEntries(bytes: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
    throw new Error('Invalid ZIP');
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (
    !count ||
    count > 2048 ||
    bytes.readUInt16LE(end + 8) !== count ||
    centralStart + centralSize !== end
  )
    throw new Error('Unsupported ZIP');
  let offset = centralStart;
  let expanded = 0;
  const entries = new Map<string, Buffer>();
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Invalid central entry');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (
      offset + 46 + nameSize + extraSize + commentSize > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      local + 30 > centralStart ||
      bytes.readUInt16LE(offset + 34)
    )
      throw new Error('Unsupported entry');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameSize);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    if (
      !name ||
      /[\\\0]/u.test(name) ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      entries.has(name)
    )
      throw new Error('Ambiguous name');
    if (
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      throw new Error('Invalid local entry');
    const localNameSize = bytes.readUInt16LE(local + 26);
    const localExtraSize = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameSize + localExtraSize;
    const stop = start + compressed;
    if (
      stop > centralStart ||
      !bytes
        .subarray(local + 30, local + 30 + localNameSize)
        .equals(nameBytes) ||
      ranges.some(([a, b]) => local < b && stop > a)
    )
      throw new Error('Invalid entry bounds');
    ranges.push([local, stop]);
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(local + 14) !== checksum ||
        bytes.readUInt32LE(local + 18) !== compressed ||
        bytes.readUInt32LE(local + 22) !== size)
    )
      throw new Error('Size/CRC mismatch');
    expanded += size;
    if (
      size > MAX_EVIDENCE_FILE_BYTES ||
      expanded > 64 * 1024 * 1024 ||
      (compressed && size / compressed > 200)
    )
      throw new Error('Expansion limit');
    const compressedBytes = bytes.subarray(start, stop);
    const data =
      method === 0
        ? compressedBytes
        : inflateRawSync(compressedBytes, {
            maxOutputLength: Math.max(1, size),
          });
    if (data.length !== size || crc32(data) !== checksum)
      throw new Error('Damaged entry');
    entries.set(name, data);
    offset += 46 + nameSize + extraSize + commentSize;
  }
  if (offset !== end) throw new Error('Invalid directory length');
  return entries;
}

function formatStatus(file: string, bytes: Buffer): Verification['status'] {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf')
    return bytes.subarray(0, 5).toString() === '%PDF-' &&
      /%%EOF\s*$/u.test(bytes.toString('latin1'))
      ? 'pending'
      : 'format_mismatch';
  if (['.zip', '.pptx', '.docx', '.xlsx'].includes(ext)) {
    const entries = zipEntries(bytes);
    if (ext !== '.zip') {
      if (!officePackageValid(entries, ext)) return 'format_mismatch';
      if (ext === '.pptx') {
        const slides = [...entries].filter(([n]) =>
          /^ppt\/slides\/slide\d+\.xml$/u.test(n),
        );
        if (
          !slides.length ||
          slides.some(
            ([, data]) =>
              !/<(?:\w+:)?t(?:\s[^>]*)?>\s*[^<\s]|<(?:\w+:)?(?:pic|graphicFrame)\b/u.test(
                data.toString('utf8'),
              ),
          )
        )
          return 'format_mismatch';
      }
      if (
        ext === '.xlsx' &&
        ![...entries.keys()].some((n) =>
          /^xl\/worksheets\/sheet\d+\.xml$/u.test(n),
        )
      )
        return 'format_mismatch';
    }
    return 'verified';
  }
  if (!['.json', '.xml', '.svg', '.md', '.txt', '.csv'].includes(ext))
    return 'unsupported';
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (ext === '.json') {
    JSON.parse(text.replace(/^\uFEFF/u, ''));
    return 'verified';
  }
  if (ext === '.xml' || ext === '.svg') {
    const root = xmlRoot(bytes);
    return ext !== '.svg' || root === 'svg' ? 'verified' : 'format_mismatch';
  }
  if (['.md', '.txt', '.csv'].includes(ext))
    return /\S/u.test(text) && !text.includes('\0')
      ? 'verified'
      : 'format_mismatch';
  // Magic bytes alone cannot verify an image, legacy Office document or HTML layout.
  return 'unsupported';
}

export function inspectArtifactFile(
  file: string,
  toolCallId: string,
): Verification {
  const observed = readVersionedFile(file);
  const base = { check: 'native_format' as const, toolCallId };
  if (!observed) return { ...base, status: 'unresolved' };
  if (!observed.bytes.length)
    return { ...base, status: 'empty', version: observed.version };
  try {
    return {
      ...base,
      status: formatStatus(file, observed.bytes),
      version: observed.version,
    };
  } catch {
    return { ...base, status: 'format_mismatch', version: observed.version };
  }
}

/** PDF parser validates the actual version, without opening any viewer or executing document scripts. */
export async function inspectPdfFile(
  file: string,
  receipt: Verification,
): Promise<Verification> {
  const observed = readVersionedFile(file);
  if (!observed || !sameFileVersion(receipt.version, observed.version))
    return { ...receipt, status: 'stale' };
  let document:
    | {
        numPages: number;
        getPage(n: number): Promise<{ getOperatorList(): Promise<unknown> }>;
        destroy(): Promise<void>;
      }
    | undefined;
  try {
    // Use the bundled parser directly: pdf-parse's wrapper swallows page failures.
    const parser = createRequire(import.meta.url)(
      'pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js',
    );
    parser.disableWorker = true;
    document = await parser.getDocument({
      data: Uint8Array.from(observed.bytes),
      isEvalSupported: false,
      disableFontFace: true,
      disableAutoFetch: true,
      stopAtErrors: true,
    }).promise;
    if (!document || document.numPages < 1 || document.numPages > 200)
      return { ...receipt, status: 'unsupported' };
    for (let page = 1; page <= document.numPages; page++)
      await (await document.getPage(page)).getOperatorList();
    const fresh = readVersionedFile(file);
    return {
      ...receipt,
      status: !sameFileVersion(observed.version, fresh?.version)
        ? 'stale'
        : 'verified',
    };
  } catch {
    return { ...receipt, status: 'format_mismatch' };
  } finally {
    await document?.destroy().catch(() => undefined);
  }
}
