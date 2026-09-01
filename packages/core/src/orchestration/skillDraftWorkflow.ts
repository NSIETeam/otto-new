/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 受控 Skill 草稿工作流：草稿隔离、结构校验、静态测试、风险披露、打包、
 * 防篡改确认安装。这里永远不执行草稿中的脚本。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import JSZip from 'jszip';
import { isBuiltinSkillName } from '../skills/seed-skills.js';
import { validateSkillDraft } from '../skills/skill-draft-validator.js';

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DRAFT_ID = /^[a-zA-Z0-9_-]{8,120}$/u;
const SCRIPT_EXTENSIONS = new Set([
  '.bash',
  '.cjs',
  '.js',
  '.mjs',
  '.ps1',
  '.py',
  '.sh',
  '.ts',
  '.tsx',
]);

export interface SkillDraftFileInput {
  path: string;
  content: string;
}

export interface SkillDraftStaticTest {
  name: string;
  status: 'passed' | 'failed' | 'needs-review';
  detail: string;
}

export interface SkillDraftRiskSummary {
  scriptFiles: string[];
  permissions: string[];
  fileChanges: string[];
  securityRisks: string[];
  executionBlocked: boolean;
}

export interface SkillDraftSummary {
  draftRelativePath: string;
  packageRelativePath?: string;
  targetName: string;
  mode: 'create' | 'enhance';
  contentHash: string;
  validationPassed: boolean;
  validationErrors: string[];
  validationWarnings: string[];
  tests: SkillDraftStaticTest[];
  packageReady: boolean;
  risk: SkillDraftRiskSummary;
  createdAt: string;
}

export interface StageSkillDraftOptions {
  userDir: string;
  candidateId: string;
  name: string;
  targetName?: string;
  mode?: 'create' | 'enhance';
  files: SkillDraftFileInput[];
}

function portable(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

function normalizeDraftRelativePath(relativePath: string): string {
  const portablePath = portable(relativePath.trim());
  if (
    !portablePath ||
    portablePath.startsWith('/') ||
    /^[a-zA-Z]:\//u.test(portablePath)
  ) {
    throw new Error('Skill 草稿文件路径必须是相对路径');
  }
  const segments = portablePath
    .split('/')
    .filter((segment) => segment && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error(`Skill 草稿文件越界：${relativePath}`);
  }
  return segments.join('/');
}

function resolveInside(root: string, relativePath: string): string {
  const normalized = normalizeDraftRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`Skill 草稿文件越界：${relativePath}`);
  }
  return resolved;
}

function resolvePendingDraftRoot(
  userDir: string,
  relativePath: string,
): string {
  const normalized = normalizeDraftRelativePath(relativePath);
  const segments = normalized.split('/');
  if (
    segments.length !== 3 ||
    segments[0] !== 'skill-drafts' ||
    segments[1] !== 'pending' ||
    !DRAFT_ID.test(segments[2])
  ) {
    throw new Error('Skill 安装来源必须是个人隔离草稿区中的待确认候选');
  }
  return resolveInside(userDir, normalized);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(
  root: string,
): Promise<Array<{ absolute: string; relative: string }>> {
  const result: Array<{ absolute: string; relative: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = portable(path.relative(root, absolute));
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`Skill 草稿不允许符号链接：${relative}`);
      if (stat.isDirectory()) await visit(absolute);
      else if (stat.isFile()) result.push({ absolute, relative });
      else throw new Error(`Skill 草稿包含不支持的文件类型：${relative}`);
    }
  };
  await visit(root);
  return result.sort((left, right) =>
    left.relative.localeCompare(right.relative),
  );
}

async function hashSkillDirectory(skillDir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await listFiles(skillDir)) {
    hash.update(`file:${file.relative}\0`);
    hash.update(await fs.readFile(file.absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function inferRisk(
  files: SkillDraftFileInput[],
  targetName: string,
  mode: 'create' | 'enhance',
): SkillDraftRiskSummary {
  const scriptFiles = files
    .filter((file) =>
      SCRIPT_EXTENSIONS.has(path.extname(file.path).toLowerCase()),
    )
    .map((file) => portable(file.path));
  const searchable = files
    .map((file) => `${file.path}\n${file.content}`)
    .join('\n');
  const permissions = new Set<string>();
  const securityRisks = new Set<string>();

  if (
    /(?:writeFile|appendFile|unlink|rename|mkdir|rmdir|Remove-Item|Set-Content|open\s*\([^\n]*['"](?:w|a|x))/iu.test(
      searchable,
    )
  ) {
    permissions.add('写入或删除本地文件');
    securityRisks.add('脚本可能修改或删除用户文件，执行前必须展示目标路径。');
  }
  if (
    /(?:child_process|subprocess|os\.system|execFile|spawn\s*\(|Start-Process|Invoke-Expression)/iu.test(
      searchable,
    )
  ) {
    permissions.add('启动外部进程或命令');
    securityRisks.add('脚本可能启动外部进程，执行命令必须单独确认。');
  }
  if (
    /(?:https?:\/\/|\bfetch\s*\(|axios\.|requests\.|urllib|Invoke-WebRequest|curl\s|wget\s)/iu.test(
      searchable,
    )
  ) {
    permissions.add('访问网络');
    securityRisks.add('脚本可能联网或传输数据，执行前必须展示域名和数据范围。');
  }
  if (
    /(?:process\.env|os\.environ|GetEnvironmentVariable|\$env:)/iu.test(
      searchable,
    )
  ) {
    permissions.add('读取环境变量');
    securityRisks.add(
      '脚本可能接触环境变量中的账号或令牌，不得把秘密写入日志或产物。',
    );
  }

  try {
    const skillFile = files.find((file) => portable(file.path) === 'SKILL.md');
    const allowedTools = skillFile
      ? (matter(skillFile.content).data as { allowedTools?: unknown })
          .allowedTools
      : undefined;
    if (Array.isArray(allowedTools)) {
      for (const tool of allowedTools) {
        if (typeof tool === 'string' && tool.trim())
          permissions.add(`调用 Otto 工具：${tool.trim()}`);
      }
    }
  } catch {
    // 结构错误由统一验证器报告，风险推断保持只读且尽力而为。
  }

  if (scriptFiles.length > 0) {
    securityRisks.add('包含脚本文件；生成、打包和安装过程均不会执行这些脚本。');
  }
  return {
    scriptFiles,
    permissions: [...permissions],
    fileChanges: files.map(
      (file) =>
        `${mode === 'enhance' ? '更新' : '新增'} skills/${targetName}/${portable(file.path)}`,
    ),
    securityRisks: [...securityRisks],
    executionBlocked: scriptFiles.length > 0,
  };
}

function staticTests(
  files: SkillDraftFileInput[],
  validationPassed: boolean,
  risk: SkillDraftRiskSummary,
): SkillDraftStaticTest[] {
  const tests: SkillDraftStaticTest[] = [
    {
      name: '结构与安全校验',
      status: validationPassed ? 'passed' : 'failed',
      detail: validationPassed
        ? 'SKILL.md、目录、敏感内容和依赖声明通过校验。'
        : '草稿存在结构或安全错误。',
    },
  ];
  for (const file of files.filter(
    (entry) => path.extname(entry.path).toLowerCase() === '.json',
  )) {
    try {
      JSON.parse(file.content);
      tests.push({
        name: `JSON 语法：${portable(file.path)}`,
        status: 'passed',
        detail: 'JSON 可以解析。',
      });
    } catch (error) {
      tests.push({
        name: `JSON 语法：${portable(file.path)}`,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (risk.scriptFiles.length > 0) {
    tests.push({
      name: '脚本行为测试',
      status: 'needs-review',
      detail:
        '为防止生成后立即执行，本阶段只做静态检查；行为测试必须在用户另行确认后于隔离环境运行。',
    });
  } else {
    tests.push({
      name: '无脚本执行面',
      status: 'passed',
      detail: '草稿不包含可执行脚本。',
    });
  }
  return tests;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function packageDraft(
  skillDir: string,
  packagePath: string,
  summary: SkillDraftSummary,
): Promise<void> {
  const zip = new JSZip();
  for (const file of await listFiles(skillDir)) {
    zip.file(
      `${summary.targetName}/${file.relative}`,
      await fs.readFile(file.absolute),
    );
  }
  zip.file('otto-draft-manifest.json', `${JSON.stringify(summary, null, 2)}\n`);
  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await fs.writeFile(packagePath, archive, { mode: 0o600 });
}

export async function stageSkillDraft(
  options: StageSkillDraftOptions,
): Promise<SkillDraftSummary> {
  if (!DRAFT_ID.test(options.candidateId))
    throw new Error('Skill 草稿编号不合法');
  if (!SKILL_NAME.test(options.name))
    throw new Error('Skill 名称必须是 1-63 位小写字母、数字或连字符');
  const targetName = options.targetName ?? options.name;
  if (!SKILL_NAME.test(targetName)) throw new Error('Skill 安装名称不合法');
  if (isBuiltinSkillName(targetName))
    throw new Error(`不能创建或覆盖 Otto 内置 Skill：${targetName}`);
  const mode = options.mode ?? 'create';
  if (!Array.isArray(options.files) || options.files.length === 0)
    throw new Error('Skill 草稿至少需要 SKILL.md');
  const normalizedFiles = options.files.map((file) => ({
    path: normalizeDraftRelativePath(file.path),
    content: file.content,
  }));
  if (!normalizedFiles.some((file) => file.path === 'SKILL.md'))
    throw new Error('Skill 草稿缺少 SKILL.md');
  if (
    new Set(normalizedFiles.map((file) => file.path)).size !==
    normalizedFiles.length
  ) {
    throw new Error('Skill 草稿包含重复文件路径');
  }

  const userDir = path.resolve(options.userDir);
  const draftsRoot = path.join(userDir, 'skill-drafts', 'pending');
  await fs.mkdir(draftsRoot, { recursive: true, mode: 0o700 });
  const finalRoot = path.join(draftsRoot, options.candidateId);
  const stagingRoot = path.join(
    draftsRoot,
    `.staging-${options.candidateId}-${process.pid}-${Date.now()}`,
  );
  const stagingSkillDir = path.join(stagingRoot, targetName);
  await fs.mkdir(stagingSkillDir, { recursive: true, mode: 0o700 });
  try {
    for (const file of normalizedFiles) {
      const filePath = resolveInside(stagingSkillDir, file.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(filePath, file.content, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }

    const validation = validateSkillDraft(stagingSkillDir);
    const risk = inferRisk(normalizedFiles, targetName, mode);
    const tests = staticTests(normalizedFiles, validation.valid, risk);
    const packageReady =
      validation.valid && !tests.some((test) => test.status === 'failed');
    const draftRelativePath = portable(path.relative(userDir, finalRoot));
    const packageRelativePath = packageReady
      ? portable(path.join(draftRelativePath, `${targetName}.otto-skill`))
      : undefined;
    const summary: SkillDraftSummary = {
      draftRelativePath,
      packageRelativePath,
      targetName,
      mode,
      contentHash: await hashSkillDirectory(stagingSkillDir),
      validationPassed: validation.valid,
      validationErrors: validation.errors.map(
        (item) => `${item.file ? `${item.file}: ` : ''}${item.message}`,
      ),
      validationWarnings: validation.warnings.map(
        (item) => `${item.file ? `${item.file}: ` : ''}${item.message}`,
      ),
      tests,
      packageReady,
      risk,
      createdAt: new Date().toISOString(),
    };
    await writeJson(path.join(stagingRoot, 'draft-manifest.json'), summary);
    if (packageReady) {
      await packageDraft(
        stagingSkillDir,
        path.join(stagingRoot, `${targetName}.otto-skill`),
        summary,
      );
    }

    let backupRoot: string | undefined;
    if (await pathExists(finalRoot)) {
      backupRoot = `${finalRoot}.backup-${Date.now()}`;
      await fs.rename(finalRoot, backupRoot);
    }
    try {
      await fs.rename(stagingRoot, finalRoot);
      if (backupRoot) await fs.rm(backupRoot, { recursive: true, force: true });
    } catch (error) {
      if (backupRoot && !(await pathExists(finalRoot)))
        await fs.rename(backupRoot, finalRoot);
      throw error;
    }
    return summary;
  } finally {
    await fs
      .rm(stagingRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

async function copyTree(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const stat = await fs.lstat(from);
    if (stat.isSymbolicLink())
      throw new Error(`安装包包含不允许的符号链接：${entry.name}`);
    if (stat.isDirectory()) await copyTree(from, to);
    else if (stat.isFile()) await fs.copyFile(from, to);
    else throw new Error(`安装包包含不支持的文件类型：${entry.name}`);
  }
}

export async function installConfirmedSkillDraft(
  userDirInput: string,
  summary: SkillDraftSummary,
): Promise<string> {
  const userDir = path.resolve(userDirInput);
  if (isBuiltinSkillName(summary.targetName)) {
    throw new Error(
      `禁止通过草稿流程覆盖 Otto 内置 Skill：${summary.targetName}`,
    );
  }
  const draftRoot = resolvePendingDraftRoot(userDir, summary.draftRelativePath);
  const draftSkillDir = path.join(draftRoot, summary.targetName);
  if (!(await pathExists(draftSkillDir)))
    throw new Error('Skill 草稿不存在或已被清理');
  if ((await hashSkillDirectory(draftSkillDir)) !== summary.contentHash) {
    throw new Error('Skill 草稿在用户确认前发生变化，请重新生成预览并确认');
  }
  const validation = validateSkillDraft(draftSkillDir);
  if (!validation.valid || !summary.validationPassed || !summary.packageReady) {
    throw new Error('Skill 草稿未通过结构校验、静态测试或打包，不能安装');
  }

  const skillsRoot = path.join(userDir, 'skills');
  await fs.mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  const targetDir = path.join(skillsRoot, summary.targetName);
  const targetMarker = path.join(targetDir, '.otto-builtin-skill.json');
  if (await pathExists(targetMarker)) {
    throw new Error(`禁止覆盖由 Otto 管理的内置 Skill：${summary.targetName}`);
  }
  const targetExists = await pathExists(targetDir);
  if (targetExists && summary.mode !== 'enhance') {
    throw new Error(
      `用户 Skill 已存在，必须作为明确的增强候选重新确认：${summary.targetName}`,
    );
  }

  const installRoot = path.join(
    skillsRoot,
    `.installing-${summary.targetName}-${process.pid}-${Date.now()}`,
  );
  const preparedDir = path.join(installRoot, summary.targetName);
  const backupDir = path.join(
    skillsRoot,
    `.backup-${summary.targetName}-${Date.now()}`,
  );
  await fs.mkdir(installRoot, { recursive: true, mode: 0o700 });
  try {
    if (targetExists) {
      await copyTree(targetDir, preparedDir);
      const oldSkill = path.join(targetDir, 'SKILL.md');
      if (await pathExists(oldSkill)) {
        const history = path.join(preparedDir, 'history');
        await fs.mkdir(history, { recursive: true, mode: 0o700 });
        await fs.copyFile(
          oldSkill,
          path.join(history, `SKILL.${Date.now()}.md`),
        );
      }
    }
    await copyTree(draftSkillDir, preparedDir);
    const preparedValidation = validateSkillDraft(preparedDir);
    if (!preparedValidation.valid) throw new Error('安装前最终校验失败');

    if (targetExists) await fs.rename(targetDir, backupDir);
    try {
      await fs.rename(preparedDir, targetDir);
      if (targetExists)
        await fs.rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      if (
        targetExists &&
        !(await pathExists(targetDir)) &&
        (await pathExists(backupDir))
      ) {
        await fs.rename(backupDir, targetDir);
      }
      throw error;
    }
    return path.join(targetDir, 'SKILL.md');
  } finally {
    await fs
      .rm(installRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
}
