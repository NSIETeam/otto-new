/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { parse as parseArguments } from 'shell-quote';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { DoctorService, CommandRunner } from '../services/doctor.js';
import { resolveDocumentRuntime } from '../services/bundledRuntime.js';
import { runDocumentCommand, type DocumentCommandRunner } from '../services/documentCommand.js';
import { ToolError, ToolErrorCode } from '../utils/tool-error.js';

/**
 * 执行前置体检：只读复用 DoctorService，但用一个「只放行目标二进制」的 runner，
 * 避免每次都 spawn 全部 10 个探测进程。缺任一目标依赖返回 fail-loud 错误（含平台
 * 安装命令）；全部就绪返回 null。注意：libreoffice 的 spec 名是 'libreoffice'
 * （会同时探测 libreoffice/soffice 与 mac .app 兜底）。
 */
async function preflightBinaries(names: string[], signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  const wanted = new Set(names);
  if (
    wanted.has('libreoffice')
    && resolveDocumentRuntime('libreoffice').source === 'bundled'
  ) {
    wanted.delete('libreoffice');
  }
  if (wanted.size === 0) return null;
  // 允许目标 spec 名以及其候选 bin（如 libreoffice→soffice、ghostscript→gs）都被放行。
  const binAliases = new Set<string>([...names, 'soffice', 'gs', 'gswin64c']);
  const gatedRunner: CommandRunner = (command, timeoutMs) => {
    const touches = [...binAliases].some((n) =>
      new RegExp('(^|\\s|/)' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)').test(command),
    );
    if (!touches) return Promise.reject(new Error('skipped: ' + command));
    return new Promise<string>((resolve, reject) => {
      exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024, signal, windowsHide: true }, (err, stdout, stderr) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const out = (stdout || stderr || '').trim();
        if (err) { if (out) { resolve(out); return; } reject(err); return; }
        resolve(out);
      });
    });
  };
  const report = await new DoctorService(gatedRunner).check();
  signal.throwIfAborted();
  const missing = report.checks.filter((c) => wanted.has(c.name) && !c.present);
  if (missing.length === 0) return null;
  return missing
    .map((c) => c.name + ' 未安装（' + c.category + '）。安装：' + (c.installHint || '见官方文档'))
    .join('；');
}

export interface ConvertDocumentToolParams {
  input_path?: string; input_paths?: string[];
  output_format: string; output_path?: string;
  engine?: 'pandoc' | 'libreoffice' | 'auto';
  options?: string; merge?: boolean; compress?: number;
}

export interface ConvertDocumentDependencies {
  runCommand?: DocumentCommandRunner;
  preflight?: (names: string[], signal: AbortSignal) => Promise<string | null>;
}

/** Extra options are argv, never shell source; destinations belong to this tool. */
function conversionOptions(value = ''): string[] {
  const parsed = parseArguments(value, key => `$${key}`);
  if (parsed.some(arg => typeof arg !== 'string' || /^(?:-o|--output|--outdir|--convert-to|-env:UserInstallation)/i.test(arg))) {
    throw new ToolError(ToolErrorCode.PARAM_INVALID, 'convert_document: options cannot contain shell operators or override output paths');
  }
  return parsed as string[];
}

export class ConvertDocumentTool extends BaseTool<ConvertDocumentToolParams, ToolResult> {
  static readonly Name: string = 'convert_document';

  constructor(private readonly config: Config, private readonly dependencies: ConvertDocumentDependencies = {}) {
    const desc = `Lossless document format conversion using pandoc and LibreOffice.

EXAMPLES:
  Single: {input_path:"/path/to/report.docx", output_format:"pdf"}
  Batch: {input_paths:["/a.docx","/b.docx"], output_format:"pdf"}
  Merge (all PDF, lossless via pdfunite): {input_paths:["/a.pdf","/b.pdf"], output_format:"pdf", merge:true, output_path:"/merged.pdf"}
  Merge (mixed, via pandoc markdown round-trip): {input_paths:["/a.docx","/b.md"], output_format:"pdf", merge:true, output_path:"/merged.pdf"}
  Compress: {input_path:"/big.pdf", output_format:"pdf", compress:3}
  Custom: {input_path:"/doc.md", output_format:"pdf", engine:"pandoc", options:"--toc --number-sections"}

SUPPORTED FORMATS:
  Pandoc: markdown, html, pdf, docx, epub, latex, rst, org, plain, odt, rtf
  LibreOffice: pdf, docx, xlsx, pptx, odt, ods, odp, html, csv
  Engine "auto" picks best: office formats -> libreoffice, text formats -> pandoc

DEPENDENCIES: pandoc + libreoffice. macOS: brew install pandoc libreoffice. Windows: winget install pandoc LibreOffice.`;
    super(ConvertDocumentTool.Name, 'ConvertDocument', desc, Icon.FileSearch,
      {
        type: Type.OBJECT,
        properties: {
          input_path: { type: Type.STRING, description: 'Single input file (absolute path)' },
          input_paths: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Multiple input files for batch or merge mode' },
          output_format: { type: Type.STRING, description: 'Target format: pdf, docx, markdown, html, epub, latex, odt, rtf, csv' },
          output_path: { type: Type.STRING, description: 'Output file path. Default: same dir as input, new extension. Required for merge mode.' },
          engine: { type: Type.STRING, enum: ['pandoc','libreoffice','auto'], description: 'Conversion engine. Default: auto (best match)' },
          options: { type: Type.STRING, description: 'Extra CLI flags. pandoc: --toc --number-sections. libreoffice: --infilter=...' },
          merge: { type: Type.BOOLEAN, description: 'If true, merge all input_paths into one output_path. Requires output_path.' },
          compress: { type: Type.NUMBER, description: 'PDF compression level 1-5 where 1=smallest file, 5=best quality. Uses ghostscript.' },
        },
        required: ['output_format'],
      },
    );
  }

  validateToolParams(p: ConvertDocumentToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, ConvertDocumentTool.Name);
    if (e) return e;
    if (!p.input_path && (!p.input_paths || p.input_paths.length === 0))
      return 'convert_document: must provide input_path (single) or input_paths (batch/merge)';
    if (p.input_path && !path.isAbsolute(p.input_path))
      return 'convert_document: input_path must be absolute: '+p.input_path;
    if (p.input_paths) {
      for (const ip of p.input_paths) {
        if (!path.isAbsolute(ip)) return 'convert_document: input_paths must all be absolute: '+ip;
        if (!fs.existsSync(ip)) return 'convert_document: file not found: '+ip;
      }
    }
    if (p.input_path && !fs.existsSync(p.input_path))
      return 'convert_document: file not found: '+p.input_path;
    if (!p.output_format?.trim()) return 'convert_document: output_format required (e.g. pdf, docx, markdown)';
    if (!/^[a-z][a-z0-9]{0,15}$/.test(p.output_format)) return 'convert_document: invalid output_format';
    if (p.output_path && !path.isAbsolute(p.output_path)) return 'convert_document: output_path must be absolute';
    if (p.compress !== undefined && (!Number.isInteger(p.compress) || p.compress < 1 || p.compress > 5)) return 'convert_document: compress must be an integer from 1 to 5';
    if (p.input_paths && p.input_path) return 'convert_document: choose single or batch inputs, not both';
    if (p.input_paths && !p.merge && p.output_path) return 'convert_document: batch inputs need separate output paths; omit output_path';
    if (p.input_paths && !p.merge) {
      const canonical = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
      const inputs = new Set(p.input_paths.map(canonical));
      const outputs = new Set<string>();
      for (const input of p.input_paths) {
        const output = canonical(path.join(path.dirname(input), path.basename(input, path.extname(input)) + '.' + p.output_format));
        if (outputs.has(output) || (inputs.has(output) && output !== canonical(input))) return 'convert_document: same-name batch output collision; use separate conversions and output paths';
        outputs.add(output);
      }
    }
    try { conversionOptions(p.options); } catch (error) { return (error as Error).message; }
    if (p.merge && (!p.input_paths || p.input_paths.length < 2))
      return 'convert_document/merge: need at least 2 files in input_paths';
    if (p.merge && !p.output_path)
      return 'convert_document/merge: output_path required when merging';
    return null;
  }

  toolLocations(p: ConvertDocumentToolParams): ToolLocation[] {
    const locs: ToolLocation[] = [];
    if (p.input_path) locs.push({ path: p.input_path });
    if (p.input_paths) for (const ip of p.input_paths) locs.push({ path: ip });
    if (p.output_path) locs.push({ path: p.output_path });
    return locs;
  }

  getDescription(p: ConvertDocumentToolParams): string {
    if (p.merge) return 'merge '+ (p.input_paths?.length||0) +' docs -> '+ p.output_format;
    if (p.input_paths) return 'batch convert '+ p.input_paths.length +' files -> '+ p.output_format;
    return 'convert '+ path.basename(p.input_path!) +' -> '+ p.output_format;
  }

  async shouldConfirmExecute(p: ConvertDocumentToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (this.validateToolParams(p)) return false;
    return { type:'exec', title:'Confirm: '+this.getDescription(p), command:'convert_document', rootCommand:'convert_document', onConfirm: async ()=>{}};
  }

  async execute(p: ConvertDocumentToolParams, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    const logLabel = 'convert_document.'+(p.output_format || 'single');
    console.time(logLabel);
    const err = this.validateToolParams(p);
    if (err) { console.timeEnd(logLabel); throw new ToolError(ToolErrorCode.PARAM_INVALID, err); }

    try {
      if (p.input_paths && !p.merge) {
        const results: string[] = [];
        for (const input_path of p.input_paths) {
          signal.throwIfAborted();
          try {
            const result = await this.convert({ ...p, input_path, input_paths: undefined }, signal);
            results.push(String(result.returnDisplay));
          } catch (error) {
            if (signal.aborted) throw error;
            throw new ToolError(ToolErrorCode.EXECUTION_FAILED, `convert_document batch incomplete: ${results.length}/${p.input_paths.length} files converted. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        }
        return { llmContent: results.join('\n'), returnDisplay: `convert_document OK: ${results.length} files batch-converted` };
      }
      return await this.convert(p, signal);
    } catch (e: unknown) {
      signal.throwIfAborted();
      const m = e instanceof Error ? e.message : String(e);
      if (
        m.includes('not found')
        || m.includes('command not found')
        || m.includes('not recognized')
        || m.includes('无法将')
        || (m.startsWith('spawn ') && (e as NodeJS.ErrnoException).code === 'ENOENT')
      ) {
        const isMac = process.platform === 'darwin';
        throw new ToolError(ToolErrorCode.TOOL_NOT_INSTALLED, 'convert_document: '+m+'. Install: '+(isMac?'brew install pandoc libreoffice':'winget install pandoc LibreOffice'), { cause: e });
      }
      throw e;
    } finally {
      console.timeEnd(logLabel);
    }
  }

  private async requireBinaries(names: string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const missing = await (this.dependencies.preflight ?? preflightBinaries)(names, signal);
    signal.throwIfAborted();
    if (missing) throw new ToolError(ToolErrorCode.TOOL_NOT_INSTALLED, 'convert_document: ' + missing);
  }

  private async command(file: string, args: string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await (this.dependencies.runCommand ?? runDocumentCommand)(file, args, {
      signal, timeout: 60_000, maxBuffer: 50 * 1024 * 1024,
    });
    signal.throwIfAborted();
  }

  private requireOutput(file: string): void {
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size === 0) {
      throw new ToolError(ToolErrorCode.EXECUTION_FAILED, 'convert_document produced no non-empty output');
    }
  }

  private async render(input: string, output: string, p: ConvertDocumentToolParams, signal: AbortSignal): Promise<void> {
    const ext = path.extname(input).slice(1).toLowerCase();
    const office = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];
    const engine = p.engine && p.engine !== 'auto' ? p.engine
      : office.includes(ext) || [...office, 'pdf'].includes(p.output_format) ? 'libreoffice' : 'pandoc';
    const extra = conversionOptions(p.options);
    await this.requireBinaries([engine], signal);
    if (engine === 'libreoffice') {
      const dir = path.dirname(output);
      // Isolate the profile so a running office app cannot absorb this command.
      await this.command(resolveDocumentRuntime('libreoffice').executable, [
        '-env:UserInstallation=' + pathToFileURL(path.join(dir, 'lo-profile')).href,
        '--headless', '--convert-to', p.output_format, '--outdir', dir, ...extra, input,
      ], signal);
      const generated = path.join(dir, path.basename(input, path.extname(input)) + '.' + p.output_format);
      this.requireOutput(generated);
      if (generated !== output) fs.renameSync(generated, output);
    } else {
      const args = [input, '-o', output, ...extra];
      if (p.output_format === 'pdf' && !extra.some(arg => arg.startsWith('--pdf-engine'))) args.push('--pdf-engine=xelatex');
      await this.command('pandoc', args, signal);
    }
    this.requireOutput(output);
  }

  private async convert(p: ConvertDocumentToolParams, signal: AbortSignal): Promise<ToolResult> {
    const source = p.input_path ?? p.input_paths![0];
    const output = p.output_path ?? path.join(path.dirname(source), path.basename(source, path.extname(source)) + '.' + p.output_format);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    // All writes before commit stay in this newly allocated sibling directory.
    const stage = fs.mkdtempSync(path.join(path.dirname(output), '.otto-convert-'));
    const stagedOutput = path.join(stage, 'result.' + p.output_format);
    let lossless = false;
    try {
      signal.throwIfAborted();
      if (p.merge) {
        const inputs = p.input_paths!;
        if (inputs.every(file => path.extname(file).toLowerCase() === '.pdf') && p.output_format === 'pdf') {
          const locator = process.platform === 'win32' ? 'where' : 'which';
          try { await this.command(locator, ['pdfunite'], signal); }
          catch (error) {
            signal.throwIfAborted();
            throw new ToolError(ToolErrorCode.TOOL_NOT_INSTALLED, 'convert_document: PDF merge needs pdfunite (poppler)', { cause: error });
          }
          await this.command('pdfunite', [...inputs, stagedOutput], signal);
          lossless = true;
        } else {
          await this.requireBinaries(['pandoc'], signal);
          const parts: string[] = [];
          for (let index = 0; index < inputs.length; index++) {
            const md = path.join(stage, 'part-' + index + '.md');
            await this.command('pandoc', [inputs[index], '-o', md, '-t', 'markdown'], signal);
            this.requireOutput(md);
            parts.push(fs.readFileSync(md, 'utf8'));
          }
          const merged = path.join(stage, 'merged.md');
          fs.writeFileSync(merged, parts.join('\n\n\\pagebreak\n\n'));
          await this.render(merged, stagedOutput, p, signal);
        }
      } else if (p.compress && path.extname(source).toLowerCase() === '.pdf' && p.output_format === 'pdf') {
        fs.copyFileSync(source, stagedOutput);
      } else {
        await this.render(source, stagedOutput, p, signal);
      }
      this.requireOutput(stagedOutput);
      if (p.compress && p.output_format === 'pdf') {
        await this.requireBinaries(['ghostscript'], signal);
        const compressed = path.join(stage, 'compressed.pdf');
        const settings = ['/default', '/screen', '/ebook', '/printer', '/prepress', '/prepress'];
        await this.command(process.platform === 'win32' ? 'gswin64c' : 'gs', [
          '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', '-dPDFSETTINGS=' + settings[p.compress],
          '-dNOPAUSE', '-dQUIET', '-dBATCH', '-sOutputFile=' + compressed, stagedOutput,
        ], signal);
        this.requireOutput(compressed);
        fs.renameSync(compressed, stagedOutput);
      }
      signal.throwIfAborted();
      const size = fs.statSync(stagedOutput).size;
      fs.renameSync(stagedOutput, output);
      const label = 'convert_document OK: ' + path.basename(output) + ' (' + size + ' bytes' + (lossless ? ', lossless' : '') + ')';
      return { llmContent: label, returnDisplay: label };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}
