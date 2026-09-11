import { spawnSync } from 'node:child_process';
import path from 'node:path';

const BLOCK_SIZE = 512;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** List every extracted name before rejecting AppleDouble and Finder metadata. */
export function assertPortableArchiveEntries(archivePath) {
  const result = spawnSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
    // Real production paths make the complete list exceed Node's 1 MiB default.
    // This bound is local to listing, not a blanket increase for build commands.
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`enterprise archive listing failed (${result.error?.code ?? result.signal ?? result.status}); incomplete output rejected`);
  }
  if (typeof result.stdout !== 'string' || !result.stdout.endsWith('\n')) {
    throw new Error('enterprise archive listing missing or incomplete');
  }
  const entries = result.stdout.split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error('enterprise archive listing is empty');
  const forbidden = entries.filter(entry => path.basename(entry).startsWith('._') || path.basename(entry) === '.DS_Store');
  if (forbidden.length) throw new Error(`archive contains non-portable entries: ${forbidden.slice(0, 10).join(', ')}`);
  return entries;
}

function readOctal(bytes, label) {
  const raw = bytes.toString('latin1');
  if (!/^ *[0-7]+[\0 ]*$/.test(raw)) throw new Error(`invalid tar ${label}`);
  const value = raw.replace(/[\0 ]+$/g, '').trim();
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid tar ${label}`);
  return number;
}

function inspectPax(body) {
  for (let offset = 0; offset < body.length;) {
    const separator = body.indexOf(32, offset);
    if (separator < 0 || separator - offset > 15) throw new Error('invalid PAX record length');
    const digits = body.subarray(offset, separator).toString('latin1');
    if (!/^[1-9][0-9]*$/.test(digits)) throw new Error('invalid PAX record length');
    const length = Number(digits);
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > body.length || end <= separator + 2 || body[end - 1] !== 10) {
      throw new Error('invalid PAX record boundary');
    }
    let record;
    try {
      record = utf8.decode(body.subarray(separator + 1, end - 1));
    } catch {
      throw new Error('invalid UTF-8 PAX metadata');
    }
    const equals = record.indexOf('=');
    if (equals <= 0 || record.includes('\0')) throw new Error('invalid PAX attribute');
    const key = record.slice(0, equals);
    // This package uses ordinary files below TAR's octal size limit. Reject
    // overrides instead of allowing an extractor/checker boundary mismatch.
    if (key === 'size' || key.startsWith('GNU.sparse.') || key === 'SCHILY.realsize') {
      throw new Error(`unsupported PAX layout attribute: ${key}`);
    }
    if (key.startsWith('LIBARCHIVE.xattr.') || key.startsWith('SCHILY.xattr.') || key === 'com.apple.provenance') {
      throw new Error(`archive contains non-portable metadata attribute: ${key}`);
    }
    offset = end;
  }
}

/** Inspect TAR metadata, never regular file contents (libvips embeds xattr names). */
export function assertPortableTarMetadata(archiveTar) {
  if (!Buffer.isBuffer(archiveTar)) throw new TypeError('tar archive must be a Buffer');
  let offset = 0;
  while (offset + BLOCK_SIZE <= archiveTar.length) {
    const header = archiveTar.subarray(offset, offset + BLOCK_SIZE);
    if (header.every(byte => byte === 0)) {
      if (offset + 2 * BLOCK_SIZE > archiveTar.length) throw new Error('missing tar end blocks');
      if (archiveTar.subarray(offset).some(byte => byte !== 0)) throw new Error('nonzero trailing tar data');
      if (archiveTar.length % BLOCK_SIZE !== 0) throw new Error('truncated tar end padding');
      return;
    }
    const expectedChecksum = readOctal(header.subarray(148, 156), 'checksum');
    let actualChecksum = 0;
    for (let index = 0; index < BLOCK_SIZE; index++) {
      actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (expectedChecksum !== actualChecksum) throw new Error('invalid tar header checksum');
    const size = readOctal(header.subarray(124, 136), 'size');
    const bodyStart = offset + BLOCK_SIZE;
    const next = bodyStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (!Number.isSafeInteger(next) || next > archiveTar.length) throw new Error('truncated tar entry body');
    // POSIX local/global extended headers are the only PAX metadata records.
    // Long-name records and ordinary binary files must not be substring-scanned.
    if (header[156] === 120 || header[156] === 103) {
      inspectPax(archiveTar.subarray(bodyStart, bodyStart + size));
    }
    offset = next;
  }
  throw new Error('missing or truncated tar end blocks');
}
