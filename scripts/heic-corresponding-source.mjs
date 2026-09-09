/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const manifestPath = fileURLToPath(
  new URL('./heic-corresponding-source-inputs.json', import.meta.url),
);
export const HEIC_SOURCE_INPUTS = Object.freeze(
  JSON.parse(readFileSync(manifestPath, 'utf8')).sources,
);
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const outside = (root, value) => {
  const relative = path.relative(realpathSync(root), path.resolve(value));
  return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};
function git(root, ...args) {
  return execFileSync('git', ['-c', `safe.directory=${root}`, ...args], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}
export function sourceAssetName(version) {
  requireThat(
    typeof version === 'string' &&
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version),
    'source sidecar requires a stable release version',
  );
  return `otto-${version}-corresponding-source.tar.gz`;
}
export function assertHeicLock(lock) {
  requireThat(
    lock?.lockfileVersion === 3 &&
      lock.packages?.['packages/server']?.dependencies?.['heic-decode'] ===
        '2.1.0',
    'source sidecar requires the exact reviewed HEIC lock',
  );
  return ['heic-decode', 'libheif-js'].map((name) => {
    const spec = HEIC_SOURCE_INPUTS.find(
      (input) => input.file.startsWith(`${name}-`) && input.integrity,
    );
    const entry = lock.packages[`node_modules/${name}`];
    const version = name === 'heic-decode' ? '2.1.0' : '1.23.2';
    requireThat(
      entry?.version === version &&
        entry.resolved === spec.url &&
        entry.integrity === spec.integrity,
      `unreviewed locked ${name} source`,
    );
    return { name, ...entry };
  });
}
export function assertCleanSource(repoRoot) {
  requireThat(
    git(repoRoot, 'status', '--porcelain=v1', '--untracked-files=all')
      .length === 0,
    'corresponding source requires clean HEAD (including staged and untracked files)',
  );
  const sourceCommit = git(repoRoot, 'rev-parse', '--verify', 'HEAD')
    .toString()
    .trim();
  requireThat(/^[a-f0-9]{40}$/.test(sourceCommit), 'invalid source commit');
  const packageBytes = git(repoRoot, 'show', `${sourceCommit}:package.json`);
  const lockBytes = git(repoRoot, 'show', `${sourceCommit}:package-lock.json`);
  const version = JSON.parse(packageBytes).version;
  sourceAssetName(version);
  const dependencies = assertHeicLock(JSON.parse(lockBytes));
  return { sourceCommit, version, packageBytes, lockBytes, dependencies };
}
export function verifyDownload(bytes, spec) {
  requireThat(
    Buffer.isBuffer(bytes) &&
      bytes.length === spec.bytes &&
      bytes.length <= 64 * 1024 * 1024,
    'source archive length mismatch',
  );
  requireThat(sha256(bytes) === spec.sha256, 'source archive hash mismatch');
  if (spec.integrity)
    requireThat(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}` ===
        spec.integrity,
      'source npm integrity mismatch',
    );
  return bytes;
}
function inputName(spec) {
  requireThat(
    typeof spec.file === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(spec.file) &&
      !spec.file.includes('..'),
    'unsafe source archive name',
  );
  return spec.file;
}
export function readVerifiedCache(cacheDir, spec) {
  const filename = path.join(cacheDir, inputName(spec));
  if (!existsSync(filename)) return undefined;
  const metadata = lstatSync(filename);
  requireThat(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
    'source cache must be a regular unlinked file',
  );
  requireThat(metadata.size === spec.bytes, 'source cache length mismatch');
  return verifyDownload(readFileSync(filename), spec);
}
export async function downloadSource(spec, fetchImpl = globalThis.fetch) {
  requireThat(
    HEIC_SOURCE_INPUTS.some(
      (source) => JSON.stringify(source) === JSON.stringify(spec),
    ),
    'unreviewed source download',
  );
  const allowed = new Set([
    'codeload.github.com',
    'github.com',
    'release-assets.githubusercontent.com',
    'registry.npmjs.org',
    'www.gnu.org',
    'raw.githubusercontent.com',
  ]);
  let url = new URL(spec.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      requireThat(
        url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.port &&
          allowed.has(url.hostname),
        'source download redirect outside official hosts',
      );
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        requireThat(location, 'source redirect lacks location');
        url = new URL(location, url);
        continue;
      }
      requireThat(
        response.ok && response.body,
        'official source download failed',
      );
      const length = response.headers.get('content-length');
      requireThat(
        !length || Number(length) === spec.bytes,
        'source content length mismatch',
      );
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        requireThat(
          total <= spec.bytes && total <= 64 * 1024 * 1024,
          'source download exceeded bound',
        );
        chunks.push(Buffer.from(chunk));
      }
      return verifyDownload(Buffer.concat(chunks), spec);
    }
    throw new Error('source download redirect limit exceeded');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
function trackedFiles(repoRoot, sourceCommit) {
  return git(repoRoot, 'ls-tree', '-rz', sourceCommit)
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const split = record.indexOf('\t');
      const [mode, type, object] = record.slice(0, split).split(' ');
      const name = record.slice(split + 1);
      requireThat(
        type === 'blob' && mode !== '160000',
        'full source requires populated submodule sources, not omitted gitlinks',
      );
      requireThat(
        !/[\r\n]/.test(name),
        'source archive has unsupported newline path',
      );
      return { path: name, mode, gitBlob: object };
    });
}
// Read names from Git's ustar/PAX bytes, not the locale-sensitive display of `tar -t`.
// In particular Windows bsdtar can mix UTF-8 and octal display escapes in one name.
export function gitArchivePaths(archive) {
  const data = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cString = (field) => {
    const end = field.indexOf(0);
    return decoder.decode(end < 0 ? field : field.subarray(0, end));
  };
  const octal = (field) => {
    const value = field.toString('ascii').replaceAll('\0', '').trim();
    requireThat(/^[0-7]+$/.test(value), 'invalid Git tar numeric field');
    const number = Number.parseInt(value, 8);
    requireThat(Number.isSafeInteger(number), 'Git tar numeric overflow');
    return number;
  };
  const readPax = (bytes) => {
    const result = {};
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset);
      requireThat(
        space > offset && space - offset <= 10,
        'invalid Git PAX length',
      );
      const lengthText = bytes.subarray(offset, space).toString('ascii');
      requireThat(/^[1-9]\d*$/.test(lengthText), 'invalid Git PAX length');
      const end = offset + Number(lengthText);
      requireThat(
        end > space + 2 && end <= bytes.length && bytes[end - 1] === 10,
        'truncated Git PAX record',
      );
      const equals = bytes.indexOf(61, space + 1);
      requireThat(
        equals > space + 1 && equals < end - 1,
        'invalid Git PAX field',
      );
      const key = bytes.subarray(space + 1, equals).toString('ascii');
      requireThat(
        /^[A-Za-z0-9_.-]+$/.test(key) && !Object.hasOwn(result, key),
        'duplicate or invalid Git PAX field',
      );
      Object.defineProperty(result, key, {
        value: decoder.decode(bytes.subarray(equals + 1, end - 1)),
        enumerable: true,
      });
      offset = end;
    }
    return result;
  };
  let global = {};
  let local = {};
  let offset = 0;
  let ended = false;
  const seen = new Set();
  const files = [];
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      requireThat(
        data.length - offset >= 1024 &&
          data.subarray(offset).every((byte) => byte === 0),
        'invalid Git tar terminator',
      );
      ended = true;
      break;
    }
    let checksum = 0;
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    requireThat(
      checksum === octal(header.subarray(148, 156)),
      'Git tar checksum mismatch',
    );
    requireThat(
      header.subarray(257, 262).toString('ascii') === 'ustar',
      'unsupported Git tar format',
    );
    const size = octal(header.subarray(124, 136));
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    requireThat(next <= data.length, 'truncated Git tar member');
    const payload = data.subarray(offset + 512, offset + 512 + size);
    const type = String.fromCharCode(header[156]);
    offset = next;
    if (type === 'g' || type === 'x') {
      if (type === 'g') global = { ...global, ...readPax(payload) };
      else local = { ...local, ...readPax(payload) };
      continue;
    }
    requireThat(
      ['0', '\0', '2', '5'].includes(type),
      'unsupported Git tar member type',
    );
    const attributes = { ...global, ...local };
    local = {};
    if (attributes.size !== undefined)
      requireThat(
        /^\d+$/.test(attributes.size) && Number(attributes.size) === size,
        'unsupported Git PAX size override',
      );
    let name = attributes.path;
    if (name === undefined) {
      const prefix = cString(header.subarray(345, 500));
      name = `${prefix ? `${prefix}/` : ''}${cString(header.subarray(0, 100))}`;
    }
    requireThat(
      name.startsWith('otto-source/') && !/[\r\n\0]/.test(name),
      'unexpected Git source archive path',
    );
    requireThat(!seen.has(name), 'duplicate Git source archive path');
    seen.add(name);
    if (type === '5')
      requireThat(
        name.endsWith('/') && size === 0,
        'invalid Git source directory',
      );
    else {
      requireThat(!name.endsWith('/'), 'invalid Git source file');
      files.push(name.slice('otto-source/'.length));
    }
  }
  requireThat(
    ended && Object.keys(local).length === 0,
    'incomplete Git tar archive',
  );
  return files.sort();
}

export function writeGitSourceArchive(repoRoot, output, sourceCommit) {
  requireThat(!existsSync(output), 'refusing to overwrite source archive');
  const files = trackedFiles(repoRoot, sourceCommit);
  git(
    repoRoot,
    'archive',
    '--format=tar.gz',
    '--prefix=otto-source/',
    `--output=${output}`,
    sourceCommit,
  );
  const listed = gitArchivePaths(readFileSync(output));
  requireThat(
    JSON.stringify(listed) ===
      JSON.stringify(files.map((file) => file.path).sort()),
    'git archive is incomplete: tracked source omitted or expanded',
  );
  return {
    sha256: sha256(readFileSync(output)),
    fileCount: files.length,
    files,
  };
}
export async function buildCorrespondingSource({
  repoRoot,
  outputDir,
  cacheDir,
}) {
  repoRoot = realpathSync(repoRoot);
  requireThat(
    outside(repoRoot, outputDir) && (!cacheDir || outside(repoRoot, cacheDir)),
    'source output and cache must be outside the checkout',
  );
  const snapshot = assertCleanSource(repoRoot);
  const stage = mkdtempSync(
    path.join(os.tmpdir(), 'otto-corresponding-source-'),
  );
  const stageIdentity = realpathSync(stage);
  try {
    const name = sourceAssetName(snapshot.version);
    const top = `otto-${snapshot.version}-corresponding-source`;
    const tree = path.join(stage, top);
    mkdirSync(path.join(tree, 'upstream'), { recursive: true });
    const source = writeGitSourceArchive(
      repoRoot,
      path.join(tree, 'otto-source.tar.gz'),
      snapshot.sourceCommit,
    );
    const selected = [];
    for (const spec of HEIC_SOURCE_INPUTS) {
      const bytes =
        (cacheDir && readVerifiedCache(cacheDir, spec)) ||
        (await downloadSource(spec));
      writeFileSync(path.join(tree, 'upstream', inputName(spec)), bytes, {
        flag: 'wx',
      });
      if (cacheDir && !existsSync(path.join(cacheDir, spec.file))) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(path.join(cacheDir, spec.file), bytes, { flag: 'wx' });
      }
      selected.push({ ...spec });
    }
    for (const [from, to] of [
      ['docs/heic-corresponding-source.md', 'README.md'],
      ['packages/server/NOTICE', 'NOTICE'],
      ['scripts/heic-corresponding-source-inputs.json', 'upstream-inputs.json'],
    ]) {
      writeFileSync(
        path.join(tree, to),
        git(repoRoot, 'show', `${snapshot.sourceCommit}:${from}`),
        { flag: 'wx' },
      );
    }
    writeFileSync(path.join(tree, 'package-lock.json'), snapshot.lockBytes, {
      flag: 'wx',
    });
    const allDependencies = JSON.parse(snapshot.lockBytes).packages;
    const codecLocks = Object.fromEntries(
      Object.entries(allDependencies).filter(([name]) =>
        /^node_modules\/(?:heic-decode|libheif-js|sharp|@img\/sharp(?:-libvips)?-)/.test(
          name,
        ),
      ),
    );
    const inputs = {
      schemaVersion: 1,
      version: snapshot.version,
      sourceCommit: snapshot.sourceCommit,
      sourceArchive: {
        file: 'otto-source.tar.gz',
        sha256: source.sha256,
        fileCount: source.fileCount,
      },
      packageLockSha256: sha256(snapshot.lockBytes),
      upstreamInputs: selected,
      codecLocks,
      completeTrackedSource: source.files,
      buildEnvironment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        git: git(repoRoot, '--version').toString().trim(),
        tar: execFileSync('tar', ['--version']).toString().split(/\r?\n/)[0],
      },
      upstreamWasmRebuilt: false,
      legalComplianceAttestation: false,
    };
    writeFileSync(
      path.join(tree, 'source-inputs.json'),
      `${JSON.stringify(inputs, null, 2)}\n`,
      { flag: 'wx' },
    );
    requireThat(
      assertCleanSource(repoRoot).sourceCommit === snapshot.sourceCommit,
      'source HEAD changed during sidecar build',
    );
    const stagedArchive = path.join(stage, name);
    execFileSync('tar', ['-czf', stagedArchive, '-C', stage, top]);
    const bytes = readFileSync(stagedArchive);
    const digest = sha256(bytes);
    mkdirSync(outputDir, { recursive: true });
    const archivePath = path.resolve(outputDir, name);
    const sha256Path = `${archivePath}.sha256`;
    requireThat(
      !existsSync(archivePath) && !existsSync(sha256Path),
      'refusing to overwrite source release assets',
    );
    copyFileSync(stagedArchive, archivePath, constants.COPYFILE_EXCL);
    writeFileSync(sha256Path, `${digest}  ${name}\n`, { flag: 'wx' });
    requireThat(
      sha256(readFileSync(archivePath)) === digest,
      'written source sidecar hash mismatch',
    );
    return {
      archivePath,
      sha256Path,
      sourceCommit: snapshot.sourceCommit,
      version: snapshot.version,
      sha256: digest,
    };
  } finally {
    requireThat(
      path.basename(stage).startsWith('otto-corresponding-source-') &&
        realpathSync(stage) === stageIdentity &&
        path.dirname(stageIdentity) === realpathSync(os.tmpdir()),
      'unsafe source staging cleanup',
    );
    rmSync(stage, { recursive: true, force: true });
  }
}
