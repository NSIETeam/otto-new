/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto Skill 候选的只读、离线验证器。它不执行候选脚本、不访问网络、
 * 不跟随符号链接，也不修改候选目录。
 */

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { validateSkillRuntimeDependencyDeclaration } from './skill-dependency-preflight.js';

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_BYTES = 256 * 1024;
const TEXT_SCAN_BYTES = 1024 * 1024;
const ALLOWED_ROOT_ENTRIES = new Set([
  'SKILL.md',
  'LICENSE.txt',
  'NOTICE.txt',
  '.otto-builtin-skill.json',
  'agents',
  'scripts',
  'references',
  'assets',
  'evals',
  'history',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pyproject.toml',
  'requirements.txt',
  'uv.lock',
]);
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/iu,
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/iu,
  /^(?:credentials|secrets?|tokens?)\.json$/iu,
  /\.(?:key|p12|pfx|pem|kdbx)$/iu,
];
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bghp_[A-Za-z0-9]{30,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.csv',
  '.tsv',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.sh',
  '.bash',
  '.ps1',
  '.html',
  '.css',
  '.svg',
  '.xml',
]);
const FORBIDDEN_EXECUTABLE_EXTENSIONS = new Set([
  '.app',
  '.class',
  '.com',
  '.dll',
  '.dmg',
  '.dylib',
  '.exe',
  '.jar',
  '.msi',
  '.node',
  '.pkg',
  '.scr',
  '.so',
]);

export interface SkillValidationIssue {
  code: string;
  message: string;
  file?: string;
}

export interface SkillValidationReport {
  valid: boolean;
  candidatePath?: string;
  metadata?: Record<string, unknown>;
  errors: SkillValidationIssue[];
  warnings: SkillValidationIssue[];
  stats: {
    fileCount: number;
    totalBytes: number;
  };
}

interface CandidateFile {
  path: string;
  relativePath: string;
  size: number;
}

function issue(
  code: string,
  message: string,
  file?: string,
): SkillValidationIssue {
  return file ? { code, message, file } : { code, message };
}

function parseFrontmatter(markdown: string): {
  metadata?: Record<string, unknown>;
  body?: string;
  error?: string;
} {
  const normalized = markdown.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if (!normalized.startsWith('---\n')) {
    return { error: 'SKILL.md 必须以 YAML frontmatter 开始。' };
  }
  try {
    const parsed = matter(normalized);
    return {
      metadata: parsed.data as Record<string, unknown>,
      body: parsed.content.trim(),
    };
  } catch (error) {
    return {
      error: `SKILL.md 的 YAML frontmatter 无效：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isTextFile(filePath: string, size: number): boolean {
  if (size > TEXT_SCAN_BYTES) return false;
  const basename = path.basename(filePath);
  return (
    basename === 'SKILL.md' ||
    basename === 'LICENSE.txt' ||
    basename === 'NOTICE.txt' ||
    TEXT_EXTENSIONS.has(path.extname(basename).toLowerCase())
  );
}

function collectFiles(
  root: string,
  errors: SkillValidationIssue[],
): { files: CandidateFile[]; totalBytes: number } {
  const files: CandidateFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, entryPath).replaceAll('\\', '/');
      const stat = lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        errors.push(
          issue(
            'symlink-not-allowed',
            'Skill 中不允许符号链接，以免读取或打包目录外内容。',
            relativePath,
          ),
        );
        continue;
      }
      if (stat.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!stat.isFile()) {
        errors.push(
          issue(
            'unsupported-entry',
            'Skill 包含不支持的文件类型。',
            relativePath,
          ),
        );
        continue;
      }
      files.push({ path: entryPath, relativePath, size: stat.size });
      totalBytes += stat.size;
    }
  };
  visit(root);
  return { files, totalBytes };
}

export function validateSkillDraft(
  candidatePath: string,
): SkillValidationReport {
  const errors: SkillValidationIssue[] = [];
  const warnings: SkillValidationIssue[] = [];
  const unresolvedPath = path.resolve(candidatePath);
  let unresolvedStat;
  try {
    unresolvedStat = lstatSync(unresolvedPath);
  } catch {
    return {
      valid: false,
      errors: [
        issue('candidate-not-found', '候选 Skill 目录不存在或无法读取。'),
      ],
      warnings,
      stats: { fileCount: 0, totalBytes: 0 },
    };
  }
  if (unresolvedStat.isSymbolicLink()) {
    return {
      valid: false,
      errors: [
        issue('symlink-not-allowed', '候选 Skill 根目录不能是符号链接。'),
      ],
      warnings,
      stats: { fileCount: 0, totalBytes: 0 },
    };
  }

  const root = realpathSync(unresolvedPath);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory()) {
    return {
      valid: false,
      errors: [issue('candidate-not-directory', '候选路径必须是 Skill 目录。')],
      warnings,
      stats: { fileCount: 0, totalBytes: rootStat.size },
    };
  }

  const directoryName = path.basename(root);
  for (const entry of readdirSync(root)) {
    if (!ALLOWED_ROOT_ENTRIES.has(entry)) {
      warnings.push(
        issue(
          'unexpected-root-entry',
          '根目录包含非标准条目；确认它确实属于该 Skill。',
          entry,
        ),
      );
    }
  }

  let files: CandidateFile[] = [];
  let totalBytes = 0;
  try {
    ({ files, totalBytes } = collectFiles(root, errors));
  } catch (error) {
    errors.push(
      issue(
        'candidate-read-failed',
        `读取候选 Skill 失败：${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return {
      valid: false,
      candidatePath: root,
      errors,
      warnings,
      stats: { fileCount: files.length, totalBytes },
    };
  }

  if (files.length > MAX_FILES) {
    errors.push(
      issue('too-many-files', `文件数 ${files.length} 超过上限 ${MAX_FILES}。`),
    );
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    errors.push(
      issue(
        'skill-too-large',
        `Skill 总大小 ${totalBytes} 字节超过上限 ${MAX_TOTAL_BYTES} 字节。`,
      ),
    );
  }

  for (const file of files) {
    const basename = path.basename(file.relativePath);
    if (
      FORBIDDEN_EXECUTABLE_EXTENSIONS.has(path.extname(basename).toLowerCase())
    ) {
      errors.push(
        issue(
          'binary-executable-not-allowed',
          'Skill 不能携带二进制可执行文件；请改用可审查的脚本或受管工具。',
          file.relativePath,
        ),
      );
    }
    if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(basename))) {
      errors.push(
        issue(
          'sensitive-file',
          'Skill 中不能携带凭据、私钥、令牌文件或 .env。',
          file.relativePath,
        ),
      );
    }
    if (!isTextFile(file.path, file.size)) continue;
    let text: string;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    if (SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text))) {
      errors.push(
        issue(
          'embedded-secret',
          '文本中检测到疑似私钥或访问令牌；请移除并立即轮换真实凭据。',
          file.relativePath,
        ),
      );
    }
  }

  const skillFile = path.join(root, 'SKILL.md');
  const skillEntry = files.find((file) => file.path === skillFile);
  let metadata: Record<string, unknown> | undefined;
  if (!skillEntry) {
    errors.push(issue('missing-skill-md', '缺少必需文件 SKILL.md。'));
  } else if (skillEntry.size > MAX_SKILL_BYTES) {
    errors.push(
      issue(
        'skill-md-too-large',
        `SKILL.md 超过 ${MAX_SKILL_BYTES} 字节上限。`,
      ),
    );
  } else {
    const parsed = parseFrontmatter(readFileSync(skillFile, 'utf8'));
    if (parsed.error) {
      errors.push(issue('invalid-frontmatter', parsed.error, 'SKILL.md'));
    } else {
      metadata = parsed.metadata;
      const name = metadata?.name;
      const description = metadata?.description;
      if (
        typeof name !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name)
      ) {
        errors.push(
          issue(
            'invalid-name',
            'name 必须为 1-63 位小写字母、数字或连字符，并以字母或数字开头。',
            'SKILL.md',
          ),
        );
      } else if (name !== directoryName) {
        errors.push(
          issue(
            'name-directory-mismatch',
            `frontmatter name "${name}" 必须与目录名 "${directoryName}" 一致。`,
            'SKILL.md',
          ),
        );
      }
      if (typeof description !== 'string' || description.trim().length < 12) {
        errors.push(
          issue(
            'description-too-short',
            'description 必须同时说明能力和触发语境。',
            'SKILL.md',
          ),
        );
      } else {
        if (description.length > 1024) {
          errors.push(
            issue(
              'description-too-long',
              'description 不能超过 1024 个字符。',
              'SKILL.md',
            ),
          );
        }
        if (
          !/(?:当|需要|要求|提出|想要|希望|请求|use when|when (?:the )?user)/iu.test(
            description,
          )
        ) {
          warnings.push(
            issue(
              'trigger-context-unclear',
              'description 似乎没有明确说明何时触发，可能导致 Otto 漏用或误用。',
              'SKILL.md',
            ),
          );
        }
      }
      if (!parsed.body || parsed.body.length < 80) {
        errors.push(
          issue(
            'instructions-too-short',
            'SKILL.md 正文过短，无法提供可靠工作流和验收边界。',
            'SKILL.md',
          ),
        );
      }
      if (/\b(?:TODO|TBD|FIXME)\b/u.test(parsed.body ?? '')) {
        warnings.push(
          issue(
            'unfinished-placeholder',
            'SKILL.md 正文仍包含 TODO、TBD 或 FIXME。',
            'SKILL.md',
          ),
        );
      }

      const runtimeDependencies = metadata?.runtimeDependencies;
      if (runtimeDependencies !== undefined) {
        if (!Array.isArray(runtimeDependencies)) {
          errors.push(
            issue(
              'invalid-runtime-dependencies',
              'runtimeDependencies 必须是依赖对象数组。',
              'SKILL.md',
            ),
          );
        } else {
          const ids = new Set<string>();
          runtimeDependencies.forEach((dependency, index) => {
            for (const message of validateSkillRuntimeDependencyDeclaration(
              dependency,
            )) {
              errors.push(
                issue(
                  'invalid-runtime-dependency',
                  `runtimeDependencies[${index}]：${message}`,
                  'SKILL.md',
                ),
              );
            }
            if (dependency && typeof dependency === 'object') {
              const id = (dependency as { id?: unknown }).id;
              if (typeof id === 'string') {
                if (ids.has(id)) {
                  errors.push(
                    issue(
                      'duplicate-runtime-dependency',
                      `runtimeDependencies 中重复声明了 ${id}。`,
                      'SKILL.md',
                    ),
                  );
                }
                ids.add(id);
              }
            }
          });
        }
      }
    }
  }

  if (metadata) {
    const runtimeDependencies = Array.isArray(metadata.runtimeDependencies)
      ? metadata.runtimeDependencies
      : [];
    const declared = new Set(
      runtimeDependencies.flatMap((dependency) => {
        if (!dependency || typeof dependency !== 'object') return [];
        const candidate = dependency as { id?: unknown; kind?: unknown };
        return typeof candidate.id === 'string' &&
          typeof candidate.kind === 'string'
          ? [`${candidate.kind}:${candidate.id}`]
          : [];
      }),
    );
    if (
      files.some((file) =>
        /(?:^|\/)scripts\/.*\.py$/iu.test(file.relativePath),
      ) &&
      ![...declared].some(
        (entry) =>
          entry === 'command:python' || entry.startsWith('python-package:'),
      )
    ) {
      warnings.push(
        issue(
          'undeclared-python-runtime',
          'scripts/ 中包含 Python 脚本，但未声明 Python 运行依赖。',
          'SKILL.md',
        ),
      );
    }
    if (
      files.some((file) =>
        /(?:^|\/)scripts\/.*\.(?:c?js|mjs|ts)$/iu.test(file.relativePath),
      ) &&
      ![...declared].some(
        (entry) =>
          entry === 'command:node' || entry.startsWith('node-package:'),
      )
    ) {
      warnings.push(
        issue(
          'undeclared-node-runtime',
          'scripts/ 中包含 Node/TypeScript 脚本，但未声明 Node 运行依赖。',
          'SKILL.md',
        ),
      );
    }
  }

  return {
    valid: errors.length === 0,
    candidatePath: root,
    metadata,
    errors,
    warnings,
    stats: { fileCount: files.length, totalBytes },
  };
}
