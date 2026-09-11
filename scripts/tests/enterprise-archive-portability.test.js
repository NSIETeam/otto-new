import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertPortableTarMetadata } from '../enterprise-archive-portability.mjs';

function checksum(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function entry(name, body = Buffer.alloc(0), type = '0') {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100, 8, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  checksum(header);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}

function pax(key, value) {
  const content = Buffer.from(` ${key}=${value}\n`);
  let length = content.length + 1;
  while (String(length).length + content.length !== length) length = String(length).length + content.length;
  return Buffer.concat([Buffer.from(String(length)), content]);
}

const archive = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);

describe('enterprise archive metadata portability', () => {
  it('is wired into packaging and both source identity inputs without weakening existing guards', () => {
    const builder = readFileSync(new URL('../build-enterprise-oneclick.mjs', import.meta.url), 'utf8');
    expect(builder).toContain("import { assertPortableArchiveEntries, assertPortableTarMetadata } from './enterprise-archive-portability.mjs'");
    expect(builder).toContain('assertPortableTarMetadata(archiveTar)');
    for (const name of ['sourceScope', 'sourceInputFiles']) {
      expect(builder.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\]`))?.[1]).toContain("'scripts/enterprise-archive-portability.mjs'");
    }
    expect(builder).toContain("['--no-xattrs', '-cf'");
    expect(builder).toContain("COPYFILE_DISABLE: '1'");
    expect(builder).toContain('assertPortableArchiveEntries(archive)');
    expect(builder).toContain("run('tar', ['-xzf', archive, '-C', archiveSmokeRoot])");
    expect(builder).toContain("path.join(archiveSmokeRoot, finalPackageName, 'release')");
  });
  it('accepts regular binary payload strings used by the locked libvips libraries', () => {
    const binary = Buffer.concat([Buffer.from([0, 255, 127]), Buffer.from('LIBARCHIVE.xattr.\0SCHILY.xattr.\0com.apple.provenance\0')]);
    expect(() => assertPortableTarMetadata(archive(entry('release/libvips-cpp.so', binary)))).not.toThrow();
  });

  it('accepts normal portable PAX path/mtime records with byte-counted Unicode', () => {
    const body = Buffer.concat([pax('path', 'release/很长的企业文件名.txt'), pax('mtime', '1789058986.1')]);
    expect(() => assertPortableTarMetadata(archive(entry('PaxHeader', body, 'x'), entry('file', 'ok')))).not.toThrow();
  });

  it('does not mistake ordinary PAX comment values for attribute names', () => {
    expect(() => assertPortableTarMetadata(archive(entry('PaxHeader', pax('comment', 'mentions LIBARCHIVE.xattr. in documentation'), 'x'), entry('file')))).not.toThrow();
  });

  it.each(['x', 'g'])('rejects actual non-portable attributes in PAX type %s', type => {
    for (const key of ['LIBARCHIVE.xattr.user.note', 'SCHILY.xattr.com.apple.provenance', 'com.apple.provenance']) {
      expect(() => assertPortableTarMetadata(archive(entry('PaxHeader', pax(key, 'encoded'), type), entry('file')))).toThrow(/non-portable/);
    }
  });

  it('checks every PAX record, including later attributes', () => {
    const body = Buffer.concat([pax('path', 'file'), pax('mtime', '123'), pax('SCHILY.xattr.user.test', 'value')]);
    expect(() => assertPortableTarMetadata(archive(entry('PaxHeader', body, 'x'), entry('file')))).toThrow(/non-portable/);
  });

  it.each(['x', 'g'])('rejects PAX size overrides that can hide real metadata (type %s)', type => {
    const hidden = entry('HiddenPax', pax('SCHILY.xattr.user.forbidden', 'value'), 'x');
    const ordinary = entry('empty', hidden);
    const bytes = archive(entry('PaxHeader', pax('size', '0'), type), ordinary, entry('last'));
    expect(() => assertPortableTarMetadata(bytes)).toThrow(/unsupported.*PAX.*size/);
  });

  it('rejects non-ASCII or trailing garbage in numeric fields', () => {
    for (const mutate of [bytes => { bytes[124] = 0xb0; }, bytes => { bytes[126] = 0; bytes[127] = 120; }]) {
      const bytes = archive(entry('file'));
      mutate(bytes); checksum(bytes.subarray(0, 512));
      expect(() => assertPortableTarMetadata(bytes)).toThrow(/size/);
    }
  });

  it.each(['GNU.sparse.size', 'GNU.sparse.map', 'SCHILY.realsize'])('rejects unsupported sparse layout key %s', key => {
    expect(() => assertPortableTarMetadata(archive(entry('PaxHeader', pax(key, '0'), 'x'), entry('file')))).toThrow(/unsupported PAX/);
  });

  it('rejects high-bit bytes disguised as PAX record lengths', () => {
    const body = pax('path', 'file');
    body[0] |= 128;
    expect(() => assertPortableTarMetadata(archive(entry('PaxHeader', body, 'x'), entry('file')))).toThrow(/PAX record length/);
  });

  it.each(['999 path=a\n', '0 path=a\n', '12 path=a', '12 bad-field\n'])('rejects malformed PAX byte records: %s', body => {
    expect(() => assertPortableTarMetadata(archive(entry('PaxHeader', body, 'x')))).toThrow(/invalid.*PAX/);
  });

  it('rejects invalid UTF-8 PAX metadata', () => {
    expect(() => assertPortableTarMetadata(archive(entry('PaxHeader', Buffer.from([56, 32, 107, 61, 255, 10, 0, 0]), 'x')))).toThrow();
  });

  it('rejects a forged header checksum', () => {
    const bytes = archive(entry('file', 'ok'));
    bytes[100] ^= 1;
    expect(() => assertPortableTarMetadata(bytes)).toThrow(/checksum/);
  });

  it('rejects truncated file bodies instead of treating missing observation as safe', () => {
    const bytes = archive(entry('file', 'x'.repeat(1024))).subarray(0, 1024);
    expect(() => assertPortableTarMetadata(bytes)).toThrow(/truncated/);
  });

  it('rejects data after the archive end marker', () => {
    const bytes = archive(entry('file'));
    expect(() => assertPortableTarMetadata(Buffer.concat([bytes, entry('hidden', 'bad')]))).toThrow(/trailing/);
  });

  it('rejects a missing second zero end block', () => {
    expect(() => assertPortableTarMetadata(Buffer.concat([entry('file'), Buffer.alloc(512)]))).toThrow(/end/);
  });

  it('rejects invalid or oversized numeric sizes', () => {
    for (const size of ['0000000008x\0', '77777777777\0']) {
      const bytes = archive(entry('file'));
      bytes.write(size, 124, 12, 'ascii'); checksum(bytes.subarray(0, 512));
      expect(() => assertPortableTarMetadata(bytes)).toThrow(/size|truncated/);
    }
  });

  it('ignores marker-shaped bytes in normal file names', () => {
    expect(() => assertPortableTarMetadata(archive(entry('release/SCHILY.xattr.documentation.txt', 'safe')))).not.toThrow();
  });
});
