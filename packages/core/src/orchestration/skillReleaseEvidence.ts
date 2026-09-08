/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import { isBuiltinSkillName } from '../skills/seed-skills.js';
import { validateSkillDraft } from '../skills/skill-draft-validator.js';

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

export interface SkillFunctionDescription {
  title: string;
  summary: string;
  inputs: string[];
  outputs: string[];
  scope: string[];
  boundaries: string[];
}
export interface SkillAcceptanceInput {
  skillName: string;
  expectedCurrentHash: string;
  scenario: string;
  input: string;
  expected: string;
  actual: string;
  environment: string;
  verdict: 'passed' | 'failed';
  confirmed: true;
}
export interface SkillAcceptance extends Omit<
  SkillAcceptanceInput,
  'skillName' | 'expectedCurrentHash' | 'confirmed'
> {
  caseKey: string;
  source: 'user-review';
  recordedAt: string;
}
export interface SkillRelease {
  id: string;
  capturedAt: string;
  function: SkillFunctionDescription;
  files: Record<string, string>;
  staticValidation: { passed: boolean; errors: string[]; warnings: string[] };
  acceptance: SkillAcceptance[];
}
export interface SkillReleaseComparison {
  addedFiles: string[];
  changedFiles: string[];
  removedFiles: string[];
  improved: string[];
  regressed: string[];
  comparableCases: number;
  businessVerdict:
    | 'insufficient-evidence'
    | 'has-failures'
    | 'improved-in-reviewed-cases'
    | 'no-proven-improvement';
}
export interface InstalledSkillReleases {
  skillName: string;
  current: SkillRelease;
  history: SkillRelease[];
  comparison?: SkillReleaseComparison;
  warnings: string[];
}
export interface SkillRollbackInput {
  skillName: string;
  versionId: string;
  expectedCurrentHash: string;
  confirmed: true;
}

/** These are declared capabilities, never test evidence. No model invocation on display. */
export function describeSkillFunction(
  markdown: string,
  fallback: string,
): SkillFunctionDescription {
  let content = markdown;
  let description = '';
  try {
    const parsed = matter(markdown);
    content = parsed.content;
    description =
      typeof parsed.data.description === 'string'
        ? parsed.data.description
        : '';
  } catch {
    /* Invalid YAML remains visible through validation, not a UI crash. */
  }
  const clean = (line: string) =>
    line
      .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)/u, '')
      .replace(/\*\*/gu, '')
      .trim()
      .slice(0, 500);
  const section = (heading: RegExp): string[] => {
    const lines = content.split(/\r?\n/u);
    let active = false;
    const result: string[] = [];
    for (const line of lines) {
      if (/^#{1,6}\s/u.test(line)) {
        active = heading.test(line);
        continue;
      }
      if (
        active &&
        line.trim() &&
        !line.startsWith('```') &&
        !line.startsWith('<!--')
      )
        result.push(clean(line));
    }
    return result.filter(Boolean).slice(0, 6);
  };
  return {
    title:
      content
        .match(/^#\s+(.+)$/mu)?.[1]
        ?.trim()
        .slice(0, 80) || fallback,
    summary:
      description.slice(0, 500) || '用途尚未说明，请补充功能说明后再试用。',
    inputs: section(/需要你提供|输入|准备材料|前置条件|Inputs?/iu),
    outputs: section(/交付结果|输出|产出|Outputs?/iu),
    scope: section(
      /^(?!.*(?:不适用|限制|边界)).*(?:适用范围|适用场景|何时使用|触发条件|When to use)/iu,
    ),
    boundaries: section(/不适用|限制|边界|安全|Boundar|Limitations?/iu),
  };
}

function checkName(name: string): void {
  if (!NAME.test(name) || isBuiltinSkillName(name))
    throw new Error('只能管理合法命名的用户 Skill，不能修改内置 Skill');
}
async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Reject junctions/symlinks in every owned path segment, not only leaf files. */
export async function assertSkillDirectory(
  root: string,
  ...segments: string[]
): Promise<string> {
  let current = path.resolve(root);
  for (const segment of ['', ...segments]) {
    current = path.join(current, segment);
    if (await exists(current)) {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Skill 路径包含链接或不是目录');
    }
  }
  return current;
}
async function scanTree(dir: string): Promise<Record<string, string>> {
  await assertSkillDirectory(dir);
  const files: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let bytes = 0;
  let count = 0;
  async function walk(folder: string, prefix: string) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (++count > 2048) throw new Error('Skill 文件数量超过版本快照限制');
      const absolute = path.join(folder, entry.name);
      const relative = prefix + entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Skill 不能包含符号链接');
      if (stat.isDirectory()) await walk(absolute, `${relative}/`);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 64 * 1024 * 1024)
          throw new Error('Skill 超过 64 MB 版本快照限制');
        files[relative] = digest(
          Buffer.concat([
            Buffer.from(`${stat.mode & 0o777}:`),
            await fs.readFile(absolute),
          ]),
        );
      } else throw new Error('Skill 包含不支持的文件类型');
    }
  }
  await walk(dir, '');
  return files;
}
function treeHash(files: Record<string, string>): string {
  return digest(
    JSON.stringify(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')),
    ),
  );
}
export async function currentSkillHash(
  userDir: string,
  name: string,
): Promise<string | undefined> {
  checkName(name);
  const dir = await assertSkillDirectory(userDir, 'skills', name);
  return (await exists(dir)) ? treeHash(await scanTree(dir)) : undefined;
}
async function writableVersionRoot(
  userDir: string,
  name: string,
): Promise<string> {
  checkName(name);
  const root = await assertSkillDirectory(userDir, 'skill-versions', name);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}
export async function withSkillReleaseLock<T>(
  userDir: string,
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  const root = await writableVersionRoot(userDir, name);
  const lockPath = path.join(root, '.release-lock');
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        '此 Skill 正在更新或复核，请稍后重试；异常退出遗留锁需人工检查',
      );
    throw error;
  }
  try {
    return await action();
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}
async function jsonFile(file: string): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    throw new Error('版本证据文件不安全或过大');
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}
function caseKey(
  value: Pick<
    SkillAcceptanceInput,
    'scenario' | 'input' | 'expected' | 'environment'
  >,
): string {
  return digest(
    JSON.stringify([
      value.scenario,
      value.input,
      value.expected,
      value.environment,
    ]),
  );
}
function isAcceptance(value: unknown): value is SkillAcceptance {
  if (!value || typeof value !== 'object') return false;
  const item = value as SkillAcceptance;
  return (
    item.source === 'user-review' &&
    ['passed', 'failed'].includes(item.verdict) &&
    [
      'scenario',
      'input',
      'expected',
      'actual',
      'environment',
      'recordedAt',
    ].every((key) => typeof item[key as keyof SkillAcceptance] === 'string') &&
    item.caseKey === caseKey(item)
  );
}
async function readAcceptance(
  userDir: string,
  name: string,
  hash: string,
): Promise<SkillAcceptance[]> {
  const root = await assertSkillDirectory(
    userDir,
    'skill-versions',
    name,
    'reviews',
  );
  const file = path.join(root, `${hash}.json`);
  if (!(await exists(file))) return [];
  const rows = await jsonFile(file);
  if (!Array.isArray(rows) || rows.length > 200 || !rows.every(isAcceptance))
    throw new Error('试用复核记录损坏');
  return rows as SkillAcceptance[];
}
async function inspectRelease(
  userDir: string,
  name: string,
  dir: string,
): Promise<SkillRelease> {
  const files = await scanTree(dir);
  const id = treeHash(files);
  const markdown = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  const validation = validateSkillDraft(dir);
  return {
    id,
    capturedAt: (await fs.stat(path.join(dir, 'SKILL.md'))).mtime.toISOString(),
    function: describeSkillFunction(markdown, name),
    files,
    staticValidation: {
      passed: validation.valid,
      errors: validation.errors.map((item) => item.message),
      warnings: validation.warnings.map((item) => item.message),
    },
    acceptance: await readAcceptance(userDir, name, id),
  };
}

/** Called under the release lock, before changing any installed byte. Full files, not just SKILL.md. */
export async function snapshotInstalledSkill(
  userDir: string,
  name: string,
): Promise<SkillRelease> {
  const root = await writableVersionRoot(userDir, name);
  const dir = await assertSkillDirectory(userDir, 'skills', name);
  const release = await inspectRelease(userDir, name, dir);
  const destination = await assertSkillDirectory(root, release.id);
  if (await exists(destination)) {
    if (
      treeHash(
        await scanTree(await assertSkillDirectory(destination, 'files', name)),
      ) !== release.id
    )
      throw new Error('历史快照损坏，拒绝继续覆盖当前版本');
    return release;
  }
  const staging = path.join(root, `.staging-${randomUUID()}`);
  try {
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.cp(dir, path.join(staging, 'files', name), {
      recursive: true,
      preserveTimestamps: true,
      dereference: false,
    });
    if (
      treeHash(await scanTree(path.join(staging, 'files', name))) !==
        release.id ||
      (await currentSkillHash(userDir, name)) !== release.id
    )
      throw new Error('Skill 在保存快照时发生变化');
    await fs.writeFile(
      path.join(staging, 'manifest.json'),
      JSON.stringify({ id: release.id, capturedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    await fs.rename(staging, destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return release;
}

export function compareSkillReleases(
  previous: SkillRelease,
  next: SkillRelease,
): SkillReleaseComparison {
  const cases = (rows: SkillAcceptance[]) => {
    const grouped = new Map<string, SkillAcceptance>();
    for (const item of rows) {
      // One failure keeps the scenario qualified as unstable; a later pass must not hide it.
      if (grouped.get(item.caseKey)?.verdict !== 'failed')
        grouped.set(item.caseKey, item);
    }
    return grouped;
  };
  const earlier = cases(previous.acceptance);
  const comparable = [...cases(next.acceptance).values()].filter((item) =>
    earlier.has(item.caseKey),
  );
  const improved = comparable
    .filter(
      (item) =>
        item.verdict === 'passed' &&
        earlier.get(item.caseKey)?.verdict === 'failed',
    )
    .map((item) => item.scenario);
  const regressed = comparable
    .filter(
      (item) =>
        item.verdict === 'failed' &&
        earlier.get(item.caseKey)?.verdict === 'passed',
    )
    .map((item) => item.scenario);
  return {
    addedFiles: Object.keys(next.files).filter(
      (file) => !Object.hasOwn(previous.files, file),
    ),
    changedFiles: Object.keys(next.files).filter(
      (file) =>
        Object.hasOwn(previous.files, file) &&
        previous.files[file] !== next.files[file],
    ),
    removedFiles: Object.keys(previous.files).filter(
      (file) => !Object.hasOwn(next.files, file),
    ),
    improved,
    regressed,
    comparableCases: comparable.length,
    businessVerdict: next.acceptance.some((item) => item.verdict === 'failed')
      ? 'has-failures'
      : !comparable.length
        ? 'insufficient-evidence'
        : improved.length
          ? 'improved-in-reviewed-cases'
          : 'no-proven-improvement',
  };
}

export async function listSkillReleases(
  userDir: string,
): Promise<InstalledSkillReleases[]> {
  const root = await assertSkillDirectory(userDir, 'skills');
  if (!(await exists(root))) return [];
  const result: InstalledSkillReleases[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !NAME.test(entry.name) ||
      isBuiltinSkillName(entry.name)
    )
      continue;
    const name = entry.name;
    const dir = await assertSkillDirectory(root, name);
    if (
      !(await exists(path.join(dir, 'SKILL.md'))) ||
      (await exists(path.join(dir, '.otto-builtin-skill.json')))
    )
      continue;
    const current = await inspectRelease(userDir, name, dir);
    const versionsRoot = await assertSkillDirectory(
      userDir,
      'skill-versions',
      name,
    );
    const history: SkillRelease[] = [];
    const warnings: string[] = [];
    if (await exists(versionsRoot)) {
      for (const version of await fs.readdir(versionsRoot)) {
        if (!HASH.test(version) || version === current.id) continue;
        try {
          const versionDir = await assertSkillDirectory(
            versionsRoot,
            version,
            'files',
            name,
          );
          const release = await inspectRelease(userDir, name, versionDir);
          if (release.id !== version) throw new Error('hash mismatch');
          const manifest = (await jsonFile(
            path.join(versionsRoot, version, 'manifest.json'),
          )) as { capturedAt?: unknown };
          if (typeof manifest.capturedAt === 'string')
            release.capturedAt = manifest.capturedAt;
          history.push(release);
        } catch {
          warnings.push(
            `历史版本 ${version.slice(0, 8)} 损坏或不安全，不能用于回滚。`,
          );
        }
      }
    }
    history.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    result.push({
      skillName: name,
      current,
      history,
      comparison: history[0]
        ? compareSkillReleases(history[0], current)
        : undefined,
      warnings,
    });
  }
  return result;
}

export async function recordSkillAcceptance(
  userDir: string,
  input: SkillAcceptanceInput,
): Promise<void> {
  if (input.confirmed !== true || !HASH.test(input.expectedCurrentHash))
    throw new Error('需要确认亲自复核了此版本的实际结果');
  for (const key of [
    'scenario',
    'input',
    'expected',
    'actual',
    'environment',
  ] as const) {
    if (
      typeof input[key] !== 'string' ||
      !input[key].trim() ||
      input[key].length > (key === 'scenario' ? 200 : 4000)
    )
      throw new Error('试用记录缺少内容或超过长度限制');
  }
  if (!['passed', 'failed'].includes(input.verdict))
    throw new Error('试用结果不合法');
  await withSkillReleaseLock(userDir, input.skillName, async () => {
    if (
      (await currentSkillHash(userDir, input.skillName)) !==
      input.expectedCurrentHash
    )
      throw new Error('当前版本已经变化，请重新试用并复核');
    const review: SkillAcceptance = {
      scenario: input.scenario.trim(),
      input: input.input.trim(),
      expected: input.expected.trim(),
      actual: input.actual.trim(),
      environment: input.environment.trim(),
      verdict: input.verdict,
      source: 'user-review',
      recordedAt: new Date().toISOString(),
      caseKey: '',
    };
    review.caseKey = caseKey(review);
    const old = await readAcceptance(
      userDir,
      input.skillName,
      input.expectedCurrentHash,
    );
    const next = [...old, review];
    if (next.length > 200)
      throw new Error(
        '每版最多保存 200 次复核，不覆盖已有证据；请先整理待改进事项',
      );
    const dir = await assertSkillDirectory(
      userDir,
      'skill-versions',
      input.skillName,
      'reviews',
    );
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.review-${randomUUID()}.json`);
    try {
      await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(
        temporary,
        path.join(dir, `${input.expectedCurrentHash}.json`),
      );
    } finally {
      await fs.rm(temporary, { force: true });
    }
  });
}

export async function rollbackSkillRelease(
  userDir: string,
  input: SkillRollbackInput,
): Promise<void> {
  if (input.confirmed !== true) throw new Error('回滚需要用户明确确认');
  if (!HASH.test(input.versionId) || !HASH.test(input.expectedCurrentHash))
    throw new Error('版本编号不合法');
  await withSkillReleaseLock(userDir, input.skillName, async () => {
    const name = input.skillName;
    const target = await assertSkillDirectory(userDir, 'skills', name);
    if (await exists(path.join(target, '.otto-builtin-skill.json')))
      throw new Error('不能回滚内置 Skill');
    if ((await currentSkillHash(userDir, name)) !== input.expectedCurrentHash)
      throw new Error('当前版本已经变化，请刷新后重新确认');
    if (input.versionId === input.expectedCurrentHash)
      throw new Error('此版本已经在使用');
    const source = await assertSkillDirectory(
      userDir,
      'skill-versions',
      name,
      input.versionId,
      'files',
    );
    const sourceSkill = await assertSkillDirectory(source, name);
    const release = await inspectRelease(userDir, name, sourceSkill);
    if (release.id !== input.versionId)
      throw new Error('历史快照损坏，禁止回滚');
    if (!release.staticValidation.passed)
      throw new Error('历史版本未通过当前结构与安全校验，禁止回滚');
    await snapshotInstalledSkill(userDir, name);
    const root = path.dirname(target);
    const prepared = path.join(root, `.restore-${randomUUID()}`);
    const backup = path.join(root, `.restore-backup-${randomUUID()}`);
    try {
      await fs.cp(sourceSkill, prepared, {
        recursive: true,
        preserveTimestamps: true,
        dereference: false,
      });
      if (
        treeHash(await scanTree(prepared)) !== input.versionId ||
        (await currentSkillHash(userDir, name)) !== input.expectedCurrentHash
      )
        throw new Error('回滚文件发生变化，请重新检查');
      await fs.rename(target, backup);
      try {
        await fs.rename(prepared, target);
      } catch (error) {
        await fs.rename(backup, target);
        throw error;
      }
      // The complete current version has already been retained in skill-versions.
      await fs.rm(backup, { recursive: true, force: true });
    } finally {
      await fs.rm(prepared, { recursive: true, force: true });
    }
  });
}
