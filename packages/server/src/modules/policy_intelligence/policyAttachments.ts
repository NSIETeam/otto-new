/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { DOMParser } from '@xmldom/xmldom';
import { zipEntries } from '../../artifactEvidence.js';
import type { PolicyAttachment } from './contracts.js';
import { officialPolicyUrl } from './policySources.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 100_000;
type Extraction = {
  status: 'complete' | 'partial' | 'unsupported';
  sections: NonNullable<PolicyAttachment['sections']>;
  reason?: string;
};
const review =
  '包含扫描图、公式、嵌入内容或不支持的格式，需要人工核验；不用于确定性资格判断';
function xml(bytes: Buffer): Document {
  if (bytes.length > 2 * 1024 * 1024)
    throw new Error('XML part exceeds safe parsing limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/iu.test(text))
    throw new Error('XML declarations rejected');
  return new DOMParser({
    errorHandler: {
      warning: () => {
        throw new Error('Invalid XML');
      },
      error: () => {
        throw new Error('Invalid XML');
      },
      fatalError: () => {
        throw new Error('Invalid XML');
      },
    },
  }).parseFromString(text, 'application/xml') as unknown as Document;
}
const nodes = (doc: Document | Element, name: string): Element[] =>
  Array.from(doc.getElementsByTagNameNS('*', name));
const texts = (doc: Document | Element, name: string): string =>
  nodes(doc, name)
    .map((n) => n.textContent ?? '')
    .join(' ')
    .trim();

// A static worker reads bytes only; PDF JavaScript/eval, font loading and network
// auto-fetch are disabled. Limits are defense in depth, not an OS sandbox claim.
const PDF_WORKER = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{let doc;try{
let partial=false; console.log=console.warn=console.error=()=>{partial=true};
const p=require(workerData.parser);p.disableWorker=true;
doc=await p.getDocument({data:new Uint8Array(workerData.bytes),isEvalSupported:false,disableFontFace:true,disableAutoFetch:true,stopAtErrors:true,maxImageSize:0}).promise;
if(doc.numPages<1||doc.numPages>60)throw Error('pages');
const imageOps=new Set(Object.entries(p.OPS).filter(([k])=>/image|jpeg/i.test(k)).map(([,v])=>v));
const sections=[];let length=0;
for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);const ops=await page.getOperatorList();const content=await page.getTextContent({normalizeWhitespace:true});const text=content.items.map(x=>x.str||'').join(' ').trim();if(text.length<10||text.includes('\uFFFD')||ops.fnArray.some(op=>imageOps.has(op)))partial=true;length+=text.length;if(length>100000)throw Error('text');sections.push({locator:'第 '+i+' 页',text});}
parentPort.postMessage({status:partial?'partial':'complete',sections});
}catch{parentPort.postMessage({error:true})}finally{try{await doc?.destroy()}catch{}}})();`;
let pdfWorkers = 0;
async function pdf(bytes: Buffer, signal: AbortSignal): Promise<Extraction> {
  if (
    pdfWorkers >= 2 ||
    !/%%EOF\s*$/u.test(bytes.subarray(-1024).toString('latin1'))
  )
    throw new Error('PDF unsupported or busy');
  pdfWorkers++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = (): void => {};
  try {
    worker = new Worker(PDF_WORKER, {
      eval: true,
      workerData: {
        bytes,
        parser: createRequire(import.meta.url).resolve(
          'pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js',
        ),
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise<Extraction>((resolve, reject) => {
      abort = () => reject(new Error('PDF cancelled or exceeded limits'));
      timer = setTimeout(abort, 8000);
      signal.addEventListener('abort', abort, { once: true });
      worker!.once('error', abort);
      worker!.once('exit', abort);
      worker!.once('message', (result) => {
        if (result.error || !Array.isArray(result.sections)) {
          abort();
          return;
        }
        resolve({
          ...result,
          reason: result.status === 'partial' ? review : undefined,
        });
      });
      if (signal.aborted) abort();
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await worker?.terminate();
    pdfWorkers--;
  }
}
export async function parsePolicyAttachment(
  bytes: Buffer,
  filename: string,
  signal: AbortSignal,
  depth = 0,
): Promise<Extraction> {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_BYTES)
    throw new Error('Attachment size limit');
  if (/\.pdf$/iu.test(filename)) {
    if (bytes.subarray(0, 5).toString() !== '%PDF-')
      throw new Error('PDF signature mismatch');
    return pdf(bytes, signal);
  }
  if (!/\.(?:docx|xlsx|zip)$/iu.test(filename))
    return { status: 'unsupported', sections: [], reason: review };
  const entries = zipEntries(bytes);
  const sections: Extraction['sections'] = [];
  let partial = false;
  if (/\.zip$/iu.test(filename)) {
    const children = [...entries].filter(([name]) => !name.endsWith('/'));
    if (depth > 0 || children.length > 12)
      throw new Error('Archive nesting/entry limit');
    for (const [name, value] of children) {
      signal.throwIfAborted();
      try {
        const result = await parsePolicyAttachment(
          value,
          name,
          signal,
          depth + 1,
        );
        partial ||= result.status !== 'complete';
        sections.push(
          ...result.sections.map((s) => ({
            ...s,
            locator: `${name} / ${s.locator}`,
          })),
        );
      } catch {
        partial = true;
      }
    }
  } else {
    if (
      [...entries.keys()].some((name) =>
        /(?:^|\/)(?:embeddings|media|drawings)\/|vbaProject|vmlDrawing/iu.test(
          name,
        ),
      )
    )
      partial = true;
    for (const [name, value] of entries)
      if (
        name.endsWith('.rels') &&
        /TargetMode\s*=\s*["']External["']/iu.test(value.toString())
      )
        partial = true;
    if (/\.docx$/iu.test(filename)) {
      const main = entries.get('word/document.xml');
      if (!main) throw new Error('DOCX main document missing');
      const parts = [...entries].filter(([n]) =>
        /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u.test(
          n,
        ),
      );
      for (const [name, value] of parts) {
        const doc = xml(value);
        if (
          ['altChunk', 'drawing', 'object', 'pict', 'instrText', 'del'].some(
            (n) => nodes(doc, n).length,
          )
        )
          partial = true;
        nodes(doc, 'p').forEach((p, i) => {
          const text = texts(p, 't');
          if (text) sections.push({ locator: `${name} 段落 ${i + 1}`, text });
        });
      }
    } else {
      const shared = entries.get('xl/sharedStrings.xml');
      const strings = shared
        ? nodes(xml(shared), 'si').map((n) => texts(n, 't'))
        : [];
      const sheets = [...entries].filter(([name]) =>
        /^xl\/worksheets\/sheet\d+\.xml$/u.test(name),
      );
      if (!sheets.length) throw new Error('XLSX sheets missing');
      for (const [name, value] of sheets) {
        const doc = xml(value);
        if (nodes(doc, 'f').length || nodes(doc, 'drawing').length)
          partial = true;
        for (const cell of nodes(doc, 'c')) {
          const raw = texts(cell, 'v');
          const text =
            cell.getAttribute('t') === 's'
              ? strings[Number(raw)]
              : cell.getAttribute('t') === 'inlineStr'
                ? texts(cell, 't')
                : raw;
          if (text === undefined) {
            partial = true;
            continue;
          }
          if (text)
            sections.push({
              locator: `${name} 单元格 ${cell.getAttribute('r') || '未知'}`,
              text,
            });
        }
      }
    }
  }
  if (
    sections.reduce((sum, s) => sum + s.text.length + s.locator.length, 0) >
      MAX_TEXT ||
    sections.length > 4000
  )
    throw new Error('Attachment text limit');
  signal.throwIfAborted();
  partial ||= sections.length === 0;
  return {
    status: partial ? 'partial' : 'complete',
    sections,
    reason: partial ? review : undefined,
  };
}
export async function loadPolicyAttachment(
  attachment: PolicyAttachment,
  allowedHosts: string[],
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<PolicyAttachment> {
  try {
    if (!officialPolicyUrl(attachment.url, allowedHosts))
      throw new Error('Unapproved attachment host');
    const response = await fetcher(attachment.url, {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    if (
      !response.ok ||
      /text\/html/iu.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length')) > MAX_BYTES ||
      !response.body
    )
      throw new Error('Attachment download rejected');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) throw new Error('Attachment size limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = Buffer.concat(chunks);
    // Query downloads can advertise a fixed extension in their public link label.
    const mime = response.headers
      .get('content-type')
      ?.split(';')[0]
      .trim()
      .toLowerCase();
    const typeExtension = (
      {
        'application/pdf': '.pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
          '.xlsx',
        'application/zip': '.zip',
      } as Record<string, string>
    )[mime ?? ''];
    const advertised = response.headers
      .get('content-disposition')
      ?.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/iu)?.[1];
    const pathname = decodeURIComponent(new URL(attachment.url).pathname);
    const filename =
      pathname.match(/[^/]+\.(?:pdf|docx?|xlsx?|zip)$/iu)?.[0] ??
      (advertised
        ? decodeURIComponent(advertised)
        : typeExtension
          ? `attachment${typeExtension}`
          : attachment.label);
    const result = await parsePolicyAttachment(bytes, filename, signal);
    return {
      ...attachment,
      ...result,
      parsed: result.status === 'complete',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    signal.throwIfAborted();
    return {
      label: attachment.label,
      url: attachment.url,
      parsed: false,
      status: 'failed',
      reason: '附件下载或解析失败，请从官方原文人工核验',
    };
  }
}
