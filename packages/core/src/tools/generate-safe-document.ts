/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { lstatSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Type } from '@google/genai';
import type { Config } from '../config/config.js';
import { BaseTool, Icon, type ToolResult, type ToolLocation } from './tools.js';

export interface SafeDocumentParams {
  file_path: string;
  title: string;
  slides: Array<{ title: string; body: string }>;
}
const canonical = (p: string) =>
  process.platform === 'win32' ? p.toLowerCase() : p;
function target(config: Config, raw: string): string {
  if (
    typeof raw !== 'string' ||
    raw.length > 1000 ||
    !path.isAbsolute(raw) ||
    /[\0]|^\\\\|^\/\//u.test(raw)
  )
    throw new Error('需要工作目录内的本地 PPTX 路径');
  const root = path.resolve(config.getTargetDir());
  const file = path.resolve(raw);
  const relative = path.relative(root, file);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    path.extname(file).toLowerCase() !== '.pptx' ||
    /[:*?<>|]/u.test(relative)
  )
    throw new Error(
      '受控入口目前仅支持工作目录内的 PPTX；不能改写为脚本或其他格式',
    );
  // Existing parent only; no junctions, no aliases, no overwrite. Repeat after rendering.
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    const stat = lstatSync(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonical(realpathSync(parent)) !== canonical(parent)
    )
      throw new Error('生成目录包含链接或无法核实的路径');
    if (parent === path.dirname(parent)) break;
  }
  if (existsSync(file))
    throw new Error('目标已存在，请使用新文件名；受控生成不会覆盖文件');
  return file;
}
function validate(config: Config, input: SafeDocumentParams): string {
  if (
    !input ||
    Object.keys(input).some(
      (k) => !['file_path', 'title', 'slides'].includes(k),
    ) ||
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 160 ||
    !Array.isArray(input.slides) ||
    !input.slides.length ||
    input.slides.length > 40
  )
    throw new Error(
      '只接受标题与 1–40 页纯文本；不接受脚本、模板、图片地址或其他参数',
    );
  for (const slide of input.slides) {
    if (
      !slide ||
      Object.keys(slide).some((k) => !['title', 'body'].includes(k)) ||
      typeof slide.title !== 'string' ||
      !slide.title.trim() ||
      slide.title.length > 160 ||
      typeof slide.body !== 'string' ||
      !slide.body.trim() ||
      slide.body.length > 2400
    )
      throw new Error(
        '每页需要纯文本标题和正文（最多 2400 字符），不接受可执行内容字段',
      );
  }
  return target(config, input.file_path);
}

/** Narrow data-to-file capability. Heavy renderer is lazy; there is deliberately
 * no user code, HTML, remote asset, template import, command runner or app opener. */
export class GenerateSafeDocumentTool extends BaseTool<
  SafeDocumentParams,
  ToolResult
> {
  static readonly Name = 'generate_safe_document';
  constructor(private readonly config: Config) {
    super(
      GenerateSafeDocumentTool.Name,
      '生成受控演示文稿',
      '从纯文本标题和页面正文创建新的 PPTX。适用于“不要打开 WPS/外部应用”等约束：不运行脚本、不联网、不启动外部应用、不覆盖文件。父目录须已存在。当前不支持 PDF、图表、远程图片或任意模板；不支持时应说明并保留验收，不改用未隔离脚本。生成后交付可点击链接，仍需按任务验收文件内容和版式。',
      Icon.Pencil,
      {
        type: Type.OBJECT,
        properties: {
          file_path: { type: Type.STRING },
          title: { type: Type.STRING },
          slides: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                body: { type: Type.STRING },
              },
              required: ['title', 'body'],
            },
          },
        },
        required: ['file_path', 'title', 'slides'],
      },
    );
  }
  validateToolParams(params: SafeDocumentParams): string | null {
    try {
      validate(this.config, params);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }
  toolLocations(params: SafeDocumentParams): ToolLocation[] {
    return this.validateToolParams(params) ? [] : [{ path: params.file_path }];
  }
  getDescription(): string {
    return '生成纯文本演示文稿，不启动外部应用';
  }
  async execute(
    params: SafeDocumentParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    const input = structuredClone(params);
    const file = validate(this.config, input);
    const { default: PptxGenJS } = await import('pptxgenjs');
    signal.throwIfAborted();
    // The package's legacy export-as-namespace declaration is not constructable
    // under NodeNext dynamic import. Describe only the data-only surface used.
    const Constructor = PptxGenJS as unknown as new () => {
      layout: string;
      title: string;
      author: string;
      addSlide(): {
        background: { color: string };
        addText(text: string, options: Record<string, unknown>): void;
      };
      write(options: {
        outputType: 'nodebuffer';
        compression: boolean;
      }): Promise<unknown>;
    };
    const deck = new Constructor();
    deck.layout = 'LAYOUT_WIDE';
    deck.title = input.title;
    deck.author = 'Otto';
    for (const item of input.slides) {
      const slide = deck.addSlide();
      slide.background = { color: 'FFFFFF' };
      slide.addText(item.title, {
        x: 0.6,
        y: 0.4,
        w: 12.1,
        h: 0.8,
        fontFace: 'Microsoft YaHei',
        fontSize: 28,
        color: '17223B',
        bold: true,
        fit: 'shrink',
      });
      slide.addText(item.body, {
        x: 0.6,
        y: 1.5,
        w: 12.1,
        h: 5.2,
        fontFace: 'Microsoft YaHei',
        fontSize: 20,
        color: '263248',
        breakLine: false,
        valign: 'top',
        fit: 'shrink',
      });
    }
    const output = await deck.write({
      outputType: 'nodebuffer',
      compression: true,
    });
    if (!Buffer.isBuffer(output) || output.length > 8_000_000)
      throw new Error('生成文件超过受控大小限制');
    signal.throwIfAborted();
    validate(this.config, input);
    writeFileSync(file, output, { flag: 'wx', mode: 0o600 });
    const label = path.basename(file).replace(/[[\]<>\r\n]/gu, '_');
    const link = `[${label}](<${file.replace(/\\/gu, '/')}>)`;
    return {
      llmContent: `已生成 ${input.slides.length} 页 PPTX：${link}。未启动外部应用；文件已写入，但内容及版式仍需按原要求验收。`,
      returnDisplay: link,
    };
  }
}
