import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecruitmentResumeReader, validateRecruitmentResumeUrl } from './recruitmentResumeReader.js';
import { extractRecruitmentResume } from './recruitmentResumeExtraction.js';
import { normalizeRecruitmentMaterial } from './recruitmentSourceMaterial.js';

const signal = new AbortController().signal;
const body = '前端工程师，使用 React 与 TypeScript 交付企业系统，负责测试与性能优化。';
const url = 'https://files.example.test/resume.txt?signature=secret';
const approvedOrigins = ['https://files.example.test'];
const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
const makeReader = () => createRecruitmentResumeReader({ approvedOrigins, lookup });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

// In-memory PDF fixture with valid byte offsets; exercised by the actual bundled PDF parser.
function resumePdf(pages: string[], withImage = false): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [i, text] of pages.entries()) {
    const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET${withImage ? '\nq 10 0 0 10 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ID abc EI Q' : ''}`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe('recruitment resume network boundary', () => {
  it.each(['http://files.example.test/a', 'https://evil.test/a', 'https://files.example.test.evil.test/a', 'https://u:p@files.example.test/a', 'https://files.example.test:444/a', 'file:///a', 'https://127.0.0.1/a', 'https://files.example.test/a#fragment'])('rejects %s', (value) => {
    expect(() => validateRecruitmentResumeUrl(value, approvedOrigins)).toThrow(/来源/);
  });
  it('requires an explicit origin allowlist; wildcard storage-provider approval is invalid', () => {
    expect(() => validateRecruitmentResumeUrl(url, [])).toThrow(/来源/);
    expect(() => createRecruitmentResumeReader({ approvedOrigins: ['https://*.amazonaws.com'] })).toThrow(/来源/);
  });
  it('downloads a signed URL with no OAuth/cookies, verifies text and returns safe provenance only', async () => {
    const fetcher = vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetcher);
    const check = vi.fn(async () => undefined);
    const result = await makeReader()({ url, sourceRecordId: 'source-1', signal, assertAuthorized: check });
    expect(result).toMatchObject({ completeness: 'full_text', text: body, attachment: { format: 'txt', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: Buffer.byteLength(body), extractorVersion: 'otto-resume-v1' } });
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/pdf, text/plain, application/octet-stream', 'Accept-Encoding': 'identity' } }));
    expect(JSON.stringify(result)).not.toContain('signature');
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(lookup).toHaveBeenCalledWith('files.example.test');
  });
  it.each(['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', '::ffff:127.0.0.1'])('blocks resolved non-public address %s before fetch', async (address) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const reader = createRecruitmentResumeReader({ approvedOrigins, lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
    await expect(reader({ url, sourceRecordId: 'p', signal, assertAuthorized: async () => undefined })).rejects.toThrow(/下载/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([302, 401, 403, 404, 429, 500, 206])('rejects HTTP %s without exposing the signed URL or response body', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-signature-private', { status })));
    await expect(makeReader()({ url, sourceRecordId: 'p', signal, assertAuthorized: async () => undefined })).rejects.not.toThrow(/secret|signature/);
  });
  it('rejects oversized declared and streamed bodies without parsing them', async () => {
    const args = { url, sourceRecordId: 'p', signal, assertAuthorized: async () => undefined };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('small', { headers: { 'content-length': String(9 * 1024 * 1024), 'content-type': 'text/plain' } })));
    await expect(makeReader()(args)).rejects.toThrow(/过大/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(9 * 1024 * 1024), { headers: { 'content-type': 'text/plain' } })));
    await expect(makeReader()(args)).rejects.toThrow(/过大/);
  });
  it('discards a downloaded resume when permission was revoked in flight', async () => {
    let allowed = true;
    vi.stubGlobal('fetch', vi.fn(async () => { allowed = false; return new Response(body, { headers: { 'content-type': 'text/plain' } }); }));
    await expect(makeReader()({ url, sourceRecordId: 'p', signal, assertAuthorized: async () => { if (!allowed) throw new Error('private-grant'); } })).rejects.toThrow(/授权/);
  });
});

describe('bounded resume extraction', () => {
  it('does not call a text-plus-image PDF fully extracted, even when its text layer is long enough', async () => {
    const result = await extractRecruitmentResume(resumePdf(['React engineer built enterprise applications.'], true), 'application/pdf', signal);
    expect(result.completeness).toBe('partial');
  });
  it('rejects too many PDF pages rather than silently extracting only the first forty', async () => {
    await expect(extractRecruitmentResume(resumePdf(Array.from({ length: 41 }, () => 'React engineer built enterprise applications.')), 'application/pdf', signal)).rejects.toThrow();
  });
  it('validates attachment provenance and strips any provider URLs before returning material', () => {
    const raw = { sourceRecordId: 'p', text: body, completeness: 'full_text', attachment: { sha256: 'a'.repeat(64), bytes: 100, format: 'pdf', pages: 2, extractorVersion: 'otto-resume-v1', url: 'https://private.example/secret' } };
    expect(normalizeRecruitmentMaterial(raw, 'p').attachment).toEqual({ sha256: 'a'.repeat(64), bytes: 100, format: 'pdf', pages: 2, extractorVersion: 'otto-resume-v1' });
    for (const patch of [{ sha256: 'bad' }, { bytes: -1 }, { bytes: 9 * 1024 * 1024 }, { pages: 41 }, { format: 'html' }]) {
      expect(() => normalizeRecruitmentMaterial({ ...raw, attachment: { ...raw.attachment, ...patch } }, 'p')).toThrow();
    }
  });
  it('parses all pages of a genuine text PDF with the bundled parser', async () => {
    const result = await extractRecruitmentResume(resumePdf(['React engineer built enterprise applications.', 'TypeScript testing and performance optimization.']), 'application/pdf', signal);
    expect(result).toMatchObject({ completeness: 'full_text', pages: 2, format: 'pdf' });
    expect(result.text).toContain('React engineer'); expect(result.text).toContain('TypeScript testing');
  });
  it('marks a PDF with a page lacking text as partial, not full text', async () => {
    const result = await extractRecruitmentResume(resumePdf(['React engineer built enterprise applications.', '']), 'application/pdf', signal);
    expect(result.completeness).toBe('partial');
  });
  it.each(['<html>login required</html>', '\u0000binary', 'tiny'])('does not accept %s as a complete resume', async (value) => {
    const result = await extractRecruitmentResume(Buffer.from(value), 'text/plain', signal).catch(() => ({ completeness: 'unavailable' }));
    expect(result.completeness).not.toBe('full_text');
  });
  it('rejects broken PDF, Word formats, invalid UTF-8 and text beyond the analysis limit', async () => {
    for (const [data, mime] of [[Buffer.from('%PDF-broken'), 'application/pdf'], [Buffer.from('PKbinary'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], [Buffer.from([0xff, 0xfe]), 'text/plain'], [Buffer.from('a'.repeat(80_001)), 'text/plain']] as const) {
      await expect(extractRecruitmentResume(data, mime, signal)).rejects.toThrow();
    }
  });
  it('does not parse after cancellation', async () => {
    await expect(extractRecruitmentResume(resumePdf(['React engineer']), 'application/pdf', AbortSignal.abort())).rejects.toThrow();
  });
});
