import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  parsePolicyAttachment,
  loadPolicyAttachment,
} from './policyAttachments.js';

describe('bounded official policy attachment evidence', () => {
  it('uses the real PDF parser with page references and rejects an empty/scanned page as complete evidence', async () => {
    const make = (text: string): Buffer => {
      const stream = `BT /F1 12 Tf 40 750 Td (${text}) Tj ET`;
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      ];
      let data = '%PDF-1.4\n';
      const offsets = [0];
      objects.forEach((object, i) => {
        offsets.push(Buffer.byteLength(data));
        data += `${i + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = Buffer.byteLength(data);
      data += `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return Buffer.from(data);
    };
    const result = await parsePolicyAttachment(
      make('Revenue must exceed one million yuan.'),
      'policy.pdf',
      AbortSignal.timeout(10000),
    );
    expect(result.status).toBe('complete');
    expect(result.sections[0]).toEqual({
      locator: '第 1 页',
      text: 'Revenue must exceed one million yuan.',
    });
    expect(
      (
        await parsePolicyAttachment(
          make(''),
          'scan.pdf',
          AbortSignal.timeout(10000),
        )
      ).status,
    ).toBe('partial');
  });
  it('extracts DOCX table paragraphs with locators and rejects active or malformed XML', async () => {
    const make = async (xml: string) =>
      new JSZip()
        .file('word/document.xml', xml)
        .generateAsync({ type: 'nodebuffer' });
    const bytes = await make(
      '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>申报企业营业收入不少于100万元</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>材料：审计报告</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    );
    const parsed = await parsePolicyAttachment(
      bytes,
      '条件.docx',
      AbortSignal.timeout(5000),
    );
    expect(parsed.status).toBe('complete');
    expect(parsed.sections.map((s) => s.text).join('')).toContain('审计报告');
    expect(parsed.sections[0].locator).toContain('段落');
    await expect(
      parsePolicyAttachment(
        await make(
          '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>',
        ),
        'x.docx',
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
  });
  it('resolves XLSX shared strings and refuses to bless formulas or scanned images', async () => {
    const zip = new JSZip()
      .file(
        'xl/sharedStrings.xml',
        '<sst><si><t>材料名称</t></si><si><t>营业执照</t></si></sst>',
      )
      .file(
        'xl/worksheets/sheet1.xml',
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>',
      );
    let parsed = await parsePolicyAttachment(
      await zip.generateAsync({ type: 'nodebuffer' }),
      '材料.xlsx',
      AbortSignal.timeout(5000),
    );
    expect(parsed.status).toBe('complete');
    expect(
      parsed.sections.some(
        (s) => s.text.includes('营业执照') && s.locator.includes('A2'),
      ),
    ).toBe(true);
    zip.file(
      'xl/worksheets/sheet2.xml',
      '<worksheet><c r="A1"><f>WEBSERVICE("https://evil.test")</f><v>100</v></c></worksheet>',
    );
    parsed = await parsePolicyAttachment(
      await zip.generateAsync({ type: 'nodebuffer' }),
      '材料.xlsx',
      AbortSignal.timeout(5000),
    );
    expect(parsed.status).toBe('partial');
  });
  it('handles a ZIP of documents without discarding unsupported or recursive entries', async () => {
    const inner = await new JSZip()
      .file(
        'word/document.xml',
        '<document><p><t>支持科技企业申报创新项目</t></p></document>',
      )
      .generateAsync({ type: 'nodebuffer' });
    const zip = new JSZip()
      .file('申报指南.docx', inner)
      .file('扫描件.png', 'fake');
    const parsed = await parsePolicyAttachment(
      await zip.generateAsync({ type: 'nodebuffer' }),
      '附件.zip',
      AbortSignal.timeout(5000),
    );
    expect(parsed.status).toBe('partial');
    expect(parsed.sections[0].locator).toContain('申报指南.docx');
    expect(parsed.reason).toContain('人工');
  });
  it('rejects unapproved hosts before fetch and does not follow redirects or accept HTML as a PDF', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('<html>login</html>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    const signal = AbortSignal.timeout(5000);
    const rejected = await loadPolicyAttachment(
      { label: '附件', url: 'https://evil.test/a.pdf', parsed: false },
      ['www.gov.cn'],
      fetcher,
      signal,
    );
    expect(rejected.parsed).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    const failed = await loadPolicyAttachment(
      { label: '附件', url: 'https://www.gov.cn/a.pdf', parsed: false },
      ['www.gov.cn'],
      fetcher,
      signal,
    );
    expect(failed.parsed).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(
      'https://www.gov.cn/a.pdf',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
