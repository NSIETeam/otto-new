/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Skill 运行依赖的只读预检。只执行 Otto 内置的固定探测方式，不接受
 * Skill 提供的命令或参数，防止加载第三方 Skill 时触发任意代码。
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  SkillRuntimeDependency,
  SkillRuntimeDependencyKind,
} from './skill-types.js';

export type SkillDependencyState =
  | 'ready'
  | 'missing'
  | 'outdated'
  | 'optional-missing'
  | 'not-applicable'
  | 'invalid';

export interface SkillDependencyStatus {
  dependency: SkillRuntimeDependency;
  state: SkillDependencyState;
  detectedVersion?: string;
  detail: string;
}

export interface SkillDependencyPreflightReport {
  declared: boolean;
  needsConsent: boolean;
  statuses: SkillDependencyStatus[];
}

const SUPPORTED_COMMANDS = new Set(['git', 'node', 'npm', 'python']);
const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;
const VERSION = /^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/u;

interface ProbeResult {
  available: boolean;
  version?: string;
  detail: string;
  command?: string;
  prefix?: string[];
}

function extractVersion(output: string): string | undefined {
  const match = output.match(/(?:^|\s)v?(\d+(?:\.\d+){0,3})(?:[-+][^\s]+)?/u);
  return match?.[1];
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number(part));
  const b = right.split('.').map((part) => Number(part));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function runVersionProbe(command: string, args: string[]): ProbeResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 3_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error || result.status !== 0) {
    return {
      available: false,
      detail: result.error?.message || output || `${command} 不可用。`,
    };
  }
  return {
    available: true,
    version: extractVersion(output),
    detail: output || `${command} 可用。`,
    command,
    prefix: args,
  };
}

function probeCommand(id: string): ProbeResult {
  if (!SUPPORTED_COMMANDS.has(id)) {
    return { available: false, detail: `不支持的命令依赖：${id}` };
  }
  if (id !== 'python') return runVersionProbe(id, ['--version']);

  const candidates =
    process.platform === 'win32'
      ? [
          { command: 'py', args: ['-3', '--version'], prefix: ['-3'] },
          { command: 'python', args: ['--version'], prefix: [] },
        ]
      : [
          { command: 'python3', args: ['--version'], prefix: [] },
          { command: 'python', args: ['--version'], prefix: [] },
        ];
  for (const candidate of candidates) {
    const result = runVersionProbe(candidate.command, candidate.args);
    if (result.available) {
      return {
        ...result,
        command: candidate.command,
        prefix: candidate.prefix,
      };
    }
  }
  return { available: false, detail: '未找到可用的 Python 3 运行时。' };
}

function findPackageJson(
  entryPath: string,
  packageName: string,
): string | undefined {
  let current = path.dirname(entryPath);
  for (let depth = 0; depth < 20; depth += 1) {
    const manifest = path.join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: unknown;
        };
        if (parsed.name === packageName) return manifest;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function probeNodePackage(
  packageName: string,
  searchRoots: string[],
): ProbeResult {
  if (!PACKAGE_ID.test(packageName)) {
    return { available: false, detail: `Node 包名无效：${packageName}` };
  }
  for (const root of searchRoots) {
    try {
      const requireFromRoot = createRequire(
        path.join(path.resolve(root), 'package.json'),
      );
      let manifestPath: string | undefined;
      try {
        manifestPath = requireFromRoot.resolve(`${packageName}/package.json`);
      } catch {
        const entryPath = requireFromRoot.resolve(packageName);
        manifestPath = findPackageJson(entryPath, packageName);
      }
      if (!manifestPath) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        version?: unknown;
      };
      const version =
        typeof manifest.version === 'string' ? manifest.version : undefined;
      return {
        available: true,
        version,
        detail: version
          ? `${packageName} ${version}`
          : `${packageName} 已安装。`,
      };
    } catch {
      continue;
    }
  }
  return {
    available: false,
    detail: `未在 Skill 或当前项目中找到 Node 包 ${packageName}。`,
  };
}

function probePythonPackage(packageName: string): ProbeResult {
  if (!PACKAGE_ID.test(packageName) || packageName.startsWith('@')) {
    return { available: false, detail: `Python 包名无效：${packageName}` };
  }
  const python = probeCommand('python');
  if (!python.available || !python.command) {
    return {
      available: false,
      detail: 'Python 运行时不可用，无法检查 Python 包。',
    };
  }
  const script = [
    'import importlib.metadata, sys',
    'try:',
    ' print(importlib.metadata.version(sys.argv[1]))',
    'except importlib.metadata.PackageNotFoundError:',
    ' raise SystemExit(3)',
  ].join('\n');
  return runVersionProbe(python.command, [
    ...(python.prefix ?? []),
    '-c',
    script,
    packageName,
  ]);
}

function invalidDependency(
  dependency: SkillRuntimeDependency,
  detail: string,
): SkillDependencyStatus {
  return { dependency, state: 'invalid', detail };
}

export function installationCommandForPlatform(
  dependency: SkillRuntimeDependency,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return (
    dependency.installCommands?.[platform] ||
    dependency.installCommands?.default ||
    dependency.installCommand
  );
}

export function validateSkillRuntimeDependencyDeclaration(
  raw: unknown,
): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return ['依赖声明必须是对象。'];
  const dependency = raw as Partial<SkillRuntimeDependency>;
  const errors: string[] = [];
  if (typeof dependency.id !== 'string' || !PACKAGE_ID.test(dependency.id)) {
    errors.push(`依赖 id 无效：${String(dependency.id ?? '')}`);
  }
  if (
    !['command', 'node-package', 'python-package'].includes(
      String(dependency.kind),
    )
  ) {
    errors.push(`不支持的依赖 kind：${String(dependency.kind)}`);
  }
  if (
    dependency.kind === 'command' &&
    typeof dependency.id === 'string' &&
    !SUPPORTED_COMMANDS.has(dependency.id)
  ) {
    errors.push(`命令依赖只支持 ${[...SUPPORTED_COMMANDS].join('、')}。`);
  }
  if (
    dependency.minimumVersion !== undefined &&
    (typeof dependency.minimumVersion !== 'string' ||
      !VERSION.test(dependency.minimumVersion))
  ) {
    errors.push(`minimumVersion 无效：${String(dependency.minimumVersion)}`);
  }
  if (
    typeof dependency.purpose !== 'string' ||
    dependency.purpose.trim().length < 6
  ) {
    errors.push('purpose 必须清楚说明为什么需要该依赖。');
  }
  if (typeof dependency.source !== 'string') {
    errors.push('source 必须是官方 HTTPS 地址。');
  } else {
    try {
      const sourceUrl = new URL(dependency.source);
      if (sourceUrl.protocol !== 'https:') {
        errors.push('source 必须使用 HTTPS。');
      }
      if (sourceUrl.username || sourceUrl.password) {
        errors.push('source 不能在 URL 中携带账号或密码。');
      }
      if (['localhost', '127.0.0.1', '::1'].includes(sourceUrl.hostname)) {
        errors.push('source 必须指向可核实的官方站点，不能使用本机地址。');
      }
    } catch {
      errors.push('source 必须是有效的官方 HTTPS 地址。');
    }
  }
  if (
    !['skill', 'project', 'system'].includes(String(dependency.installScope))
  ) {
    errors.push('installScope 必须是 skill、project 或 system。');
  }
  const commands = [
    ...(typeof dependency.installCommand === 'string'
      ? [dependency.installCommand]
      : []),
    ...(dependency.installCommands &&
    typeof dependency.installCommands === 'object'
      ? Object.values(dependency.installCommands).filter(
          (command): command is string => typeof command === 'string',
        )
      : []),
  ];
  if (
    commands.length === 0 ||
    commands.some((command) => command.trim().length < 3)
  ) {
    errors.push(
      'installCommand 或 installCommands 必须提供向用户预览的准确安装命令。',
    );
  }
  if (
    commands.some((command) =>
      /(?:curl|wget)[^\r\n|]*\|\s*(?:sh|bash)|Invoke-Expression|\bIEX\b|powershell(?:\.exe)?\s+-(?:e|en|enc|encodedcommand)\b/iu.test(
        command,
      ),
    )
  ) {
    errors.push('安装命令不能使用下载后直接执行或编码 PowerShell。');
  }
  if (
    commands.some((command) => /(?:&&|\|\||[;`]|\$\(|\r|\n)/u.test(command))
  ) {
    errors.push('每个安装命令必须是单一、可审计的命令，不能串联其他操作。');
  }
  if (
    commands.some((command) =>
      /\brm\s+-rf\b|\bRemove-Item\b[^\r\n]*\b-Recurse\b|\brmdir\s+\/s\b|\bdel\s+\/s\b|\bgit\s+reset\s+--hard\b/iu.test(
        command,
      ),
    )
  ) {
    errors.push('安装命令不能包含递归删除或破坏性版本控制操作。');
  }
  if (
    dependency.required !== undefined &&
    typeof dependency.required !== 'boolean'
  ) {
    errors.push('required 必须是布尔值。');
  }
  if (
    dependency.platforms !== undefined &&
    (!Array.isArray(dependency.platforms) ||
      dependency.platforms.some(
        (platform) =>
          ![
            'aix',
            'android',
            'darwin',
            'freebsd',
            'haiku',
            'linux',
            'openbsd',
            'sunos',
            'win32',
            'cygwin',
            'netbsd',
          ].includes(String(platform)),
      ))
  ) {
    errors.push('platforms 包含不支持的平台值。');
  }
  return errors;
}

function probeDependency(
  rawDependency: unknown,
  searchRoots: string[],
): SkillDependencyStatus {
  const declarationErrors =
    validateSkillRuntimeDependencyDeclaration(rawDependency);
  if (declarationErrors.length > 0) {
    const dependency =
      rawDependency && typeof rawDependency === 'object'
        ? (rawDependency as SkillRuntimeDependency)
        : {
            id: 'invalid-dependency',
            kind: 'command' as const,
            purpose: '',
            source: '',
            installScope: 'skill' as const,
          };
    return invalidDependency(dependency, declarationErrors.join(' '));
  }
  const dependency = rawDependency as SkillRuntimeDependency;
  if (
    dependency.platforms?.length &&
    !dependency.platforms.includes(process.platform)
  ) {
    return {
      dependency,
      state: 'not-applicable',
      detail: `不适用于 ${process.platform}。`,
    };
  }

  let result: ProbeResult;
  if (dependency.kind === 'command') result = probeCommand(dependency.id);
  else if (dependency.kind === 'node-package')
    result = probeNodePackage(dependency.id, searchRoots);
  else result = probePythonPackage(dependency.id);

  if (!result.available) {
    return {
      dependency,
      state: dependency.required === false ? 'optional-missing' : 'missing',
      detail: result.detail,
    };
  }
  const minimumVersion = dependency.minimumVersion?.replace(/^v/u, '');
  if (
    minimumVersion &&
    result.version &&
    compareVersions(result.version, minimumVersion) < 0
  ) {
    return {
      dependency,
      state: dependency.required === false ? 'optional-missing' : 'outdated',
      detectedVersion: result.version,
      detail: `检测到 ${result.version}，最低需要 ${minimumVersion}。`,
    };
  }
  return {
    dependency,
    state: 'ready',
    detectedVersion: result.version,
    detail: result.detail,
  };
}

export function preflightSkillDependencies(
  rawDependencies: unknown,
  searchRoots: string[],
): SkillDependencyPreflightReport {
  if (rawDependencies === undefined) {
    return { declared: false, needsConsent: false, statuses: [] };
  }
  if (!Array.isArray(rawDependencies)) {
    const placeholder = {
      id: 'invalid-runtime-dependencies',
      kind: 'command' as SkillRuntimeDependencyKind,
      purpose: '',
      source: '',
      installScope: 'skill' as const,
    };
    return {
      declared: true,
      needsConsent: false,
      statuses: [
        invalidDependency(placeholder, 'runtimeDependencies 必须是数组。'),
      ],
    };
  }
  const statuses = rawDependencies.map((dependency) =>
    probeDependency(dependency, searchRoots),
  );
  return {
    declared: true,
    needsConsent: statuses.some(
      ({ state }) => state === 'missing' || state === 'outdated',
    ),
    statuses,
  };
}
