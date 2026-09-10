import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareCorrespondingSourceRelease,
  correspondingSourceNotes,
} from '../release-corresponding-source.mjs';
import { buildExpectedDraftIdentity } from '../release-draft-creation-recovery.mjs';
import { buildExpectedPublication } from '../release-visibility-compensation.mjs';
import {
  signReleasePayload,
  verifyReleasePayload,
} from '../release-payload-signature.mjs';

const version = '1.9.15';
const commit = 'a'.repeat(40);
const name = `otto-${version}-corresponding-source.tar.gz`;
const roots = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'otto-source-release-test-'));
  roots.push(root);
  const directory = path.join(root, 'source');
  const desktopDirectory = path.join(root, 'desktop');
  await mkdir(directory);
  await mkdir(desktopDirectory);
  const archivePath = path.join(directory, name);
  const sha256Path = `${archivePath}.sha256`;
  const receiptPath = path.join(root, 'receipt.json');
  const sha256 = hash('archive');
  const receipt = {
    archivePath,
    sha256Path,
    sourceCommit: commit,
    version,
    sha256,
  };
  await writeFile(archivePath, 'archive');
  await writeFile(sha256Path, `${sha256}  ${name}\n`);
  await writeFile(receiptPath, JSON.stringify(receipt));
  const manifest = {
    version,
    notes: '# Existing notes\n',
    publishedAt: 'locked',
    assets: { unchanged: true },
  };
  for (const filename of ['latest.json', 'latest.mirror.json']) {
    await writeFile(
      path.join(desktopDirectory, filename),
      JSON.stringify(manifest),
    );
  }
  return {
    root,
    directory,
    desktopDirectory,
    receiptPath,
    receipt,
    manifest,
    version,
    sourceCommit: commit,
  };
}

describe('corresponding-source release binding', () => {
  it('binds both source hashes into the real Ed25519 release payload signature', async () => {
    const options = await fixture();
    const inputPath = path.join(options.root, 'SHA256SUMS');
    const outputPath = `${inputPath}.sig`;
    const checksumBytes = await readFile(options.receipt.sha256Path);
    const payload = `${options.receipt.sha256}  ${name}\n${hash(checksumBytes)}  ${name}.sha256\n`;
    await writeFile(inputPath, payload);
    const keys = generateKeyPairSync('ed25519');
    const privateKey = keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const publicKey = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    await signReleasePayload({ inputPath, outputPath, privateKey });
    await expect(
      verifyReleasePayload({ inputPath, signaturePath: outputPath, publicKey }),
    ).resolves.toMatchObject({ algorithm: 'Ed25519' });
    await writeFile(inputPath, payload.split('\n').slice(1).join('\n'));
    await expect(
      verifyReleasePayload({ inputPath, signaturePath: outputPath, publicKey }),
    ).rejects.toThrow('SHA-256 mismatch');
  });
  it('verifies exact source identity/bytes and only extends the existing notes field', async () => {
    const options = await fixture();
    await prepareCorrespondingSourceRelease(options);
    for (const filename of ['latest.json', 'latest.mirror.json']) {
      const actual = JSON.parse(
        await readFile(path.join(options.desktopDirectory, filename), 'utf8'),
      );
      expect(actual).toEqual({
        ...options.manifest,
        notes: options.manifest.notes + correspondingSourceNotes(version),
      });
      expect(actual.notes).toContain(
        `https://github.com/NSIETeam/otto-new/releases/download/v${version}/${name}`,
      );
      expect(actual.notes).toContain(
        `https://github.com/Felix201209/otto-releases/releases/download/v${version}/${name}`,
      );
    }
  });
  it.each([
    'sourceCommit',
    'version',
    'archivePath',
    'sha256Path',
    'sha256',
    'extra',
  ])(
    'rejects changed receipt %s before touching either update manifest',
    async (key) => {
      const options = await fixture();
      await writeFile(
        options.receiptPath,
        JSON.stringify({ ...options.receipt, [key]: 'untrusted' }),
      );
      await expect(
        prepareCorrespondingSourceRelease(options),
      ).rejects.toThrow();
      expect(
        JSON.parse(
          await readFile(
            path.join(options.desktopDirectory, 'latest.json'),
            'utf8',
          ),
        ),
      ).toEqual(options.manifest);
    },
  );
  it.each(['archive', 'checksum', 'mirror-version'])(
    'rejects %s drift without partial manifest writes',
    async (failure) => {
      const options = await fixture();
      if (failure === 'archive')
        await writeFile(options.receipt.archivePath, 'changed');
      if (failure === 'checksum')
        await writeFile(
          options.receipt.sha256Path,
          `${options.receipt.sha256}  ../elsewhere\n`,
        );
      if (failure === 'mirror-version')
        await writeFile(
          path.join(options.desktopDirectory, 'latest.mirror.json'),
          JSON.stringify({ ...options.manifest, version: '1.9.14' }),
        );
      await expect(
        prepareCorrespondingSourceRelease(options),
      ).rejects.toThrow();
      expect(
        JSON.parse(
          await readFile(
            path.join(options.desktopDirectory, 'latest.json'),
            'utf8',
          ),
        ),
      ).toEqual(options.manifest);
    },
  );
  it.each(['draft', 'publication'])(
    'the %s identity refuses a missing or duplicate corresponding-source sidecar',
    async (kind) => {
      const options = await fixture();
      const packageIdentity = '1'.repeat(12) + '-' + '2'.repeat(12);
      const files = [
        `Otto-${version}-arm64.dmg`,
        `Otto-${version}-arm64.dmg.blockmap`,
        `Otto-${version}-x64.dmg`,
        `Otto-${version}-x64.dmg.blockmap`,
        `Otto-Setup-${version}-win-x64.exe`,
        `Otto-Setup-${version}-win-x64.exe.blockmap`,
        'latest.json',
        'SHA256SUMS',
        'SHA256SUMS.sig',
        'UPDATE-MIRROR-SHA256SUMS',
        'UPDATE-MIRROR-SHA256SUMS.sig',
        ...['', '.sha256', '.sig'].map(
          (suffix) =>
            `otto-enterprise-oneclick-v${version}-${packageIdentity}.tar.gz${suffix}`,
        ),
        `${name}.sha256`,
        'release-notes.md',
      ];
      const directory = path.join(options.root, 'identity');
      await mkdir(directory);
      for (const filename of files)
        await writeFile(path.join(directory, filename), 'locked');
      const build =
        kind === 'draft'
          ? buildExpectedDraftIdentity
          : buildExpectedPublication;
      const args = {
        artifactDirectory: directory,
        version,
        packageIdentity,
        prerelease: false,
        assetProfile: 'production',
      };
      await expect(build(args)).rejects.toThrow(name);
      await writeFile(path.join(directory, name), 'source');
      expect((await build(args)).assets).toHaveLength(16);
      await mkdir(path.join(directory, 'duplicate'));
      await writeFile(path.join(directory, 'duplicate', name), 'source');
      await expect(build(args)).rejects.toThrow(name);
    },
  );
});

describe('source sidecar workflow contract', () => {
  it('matches all canonical identities before mirror publication without adding source to mirror payload', async () => {
    const repo = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../..',
    );
    const workflow = parse(
      await readFile(path.join(repo, '.github/workflows/release.yml'), 'utf8'),
    );
    const mirrorSteps = workflow.jobs['deploy-update-mirror'].steps;
    const publish = mirrorSteps.find(
      (step) => step.name === 'Upload and atomically publish mirror',
    ).run;
    const vector = publish.match(/EXPECTED_PATTERNS=\(\n([\s\S]*?)\n\)/)?.[1];
    expect(vector).toBeDefined();
    const patterns = vector
      .trim()
      .split('\n')
      .map((line) => {
        const quoted = line.trim().match(/^(?:"([^"]+)"|'([^']+)')$/);
        expect(quoted, line).not.toBeNull();
        return (quoted[1] ?? quoted[2]).replaceAll('${VERSION}', version);
      });
    const options = await fixture();
    const packageIdentity = '1'.repeat(12) + '-' + '2'.repeat(12);
    const installers = [
      `Otto-${version}-arm64.dmg`,
      `Otto-${version}-x64.dmg`,
      `Otto-Setup-${version}-win-x64.exe`,
    ];
    const publicNames = [
      ...installers.flatMap((installer) => [
        installer,
        `${installer}.blockmap`,
      ]),
      'latest.json',
      'SHA256SUMS',
      'SHA256SUMS.sig',
      'UPDATE-MIRROR-SHA256SUMS',
      'UPDATE-MIRROR-SHA256SUMS.sig',
      name,
      `${name}.sha256`,
      ...['', '.sha256', '.sig'].map(
        (suffix) =>
          `otto-enterprise-oneclick-v${version}-${packageIdentity}.tar.gz${suffix}`,
      ),
    ];
    const directory = path.join(options.root, 'canonical');
    await mkdir(directory);
    for (const filename of [...publicNames, 'release-notes.md']) {
      await writeFile(path.join(directory, filename), `locked:${filename}`);
    }
    const canonical = await buildExpectedDraftIdentity({
      artifactDirectory: directory,
      version,
      packageIdentity,
      prerelease: false,
      assetProfile: 'production',
    });
    const matched = patterns.map((pattern) => {
      const expression = new RegExp(
        '^' +
          pattern
            .split('*')
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*') +
          '$',
      );
      const matches = canonical.assets.filter((asset) =>
        expression.test(asset.name),
      );
      expect(matches, pattern).toHaveLength(1);
      return matches[0];
    });
    expect(matched.map((asset) => asset.name).sort()).toEqual(
      canonical.assets.map((asset) => asset.name).sort(),
    );
    expect(new Set(matched.map((asset) => asset.name)).size).toBe(16);
    expect(publish).toContain(
      '[ "${#actual_assets[@]}" -eq "${#expected_assets[@]}" ]',
    );
    expect(publish).toContain(
      '"${actual_assets[$index]}" != "${expected_assets[$index]}"',
    );
    const prepare = mirrorSteps.find(
      (step) => step.name === 'Prepare and verify mirror payload',
    ).run;
    const copied = [...prepare.matchAll(/^copy_one "([^"]+)"$/gm)].map(
      (match) => match[1].replaceAll('${VERSION}', version),
    );
    expect(copied.sort()).toEqual(
      [
        ...installers.flatMap((installer) => [
          installer,
          `${installer}.blockmap`,
        ]),
        'latest.mirror.json',
        'UPDATE-MIRROR-SHA256SUMS',
        'UPDATE-MIRROR-SHA256SUMS.sig',
      ].sort(),
    );
    expect(prepare).toContain(
      'mv -- mirror-upload/latest.mirror.json mirror-upload/latest.json',
    );
  });

  it('builds/recombines clean source outside checkout and attests/uploads both exact assets', async () => {
    const repo = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../..',
    );
    const workflow = parse(
      await readFile(path.join(repo, '.github/workflows/release.yml'), 'utf8'),
    );
    const steps = workflow.jobs.build.steps;
    const source = steps.find(
      (step) => step.name === 'Build and verify corresponding source',
    );
    expect(source.run).toContain(
      'node scripts/build-heic-corresponding-source.mjs',
    );
    expect(source.run).toContain('node scripts/test-heic-recombination.mjs');
    expect(source.run).toContain('$RUNNER_TEMP/otto-corresponding-source');
    expect(source.run).not.toMatch(/allow-dirty|continue-on-error/);
    const verify = steps.find((step) => step.id === 'artifacts').run;
    expect(
      verify.indexOf('node scripts/release-corresponding-source.mjs'),
    ).toBeLessThan(verify.indexOf('for artifact in "${FILES[@]}"'));
    expect(verify).toContain(
      'FILES+=("$SOURCE_ARCHIVE" "${SOURCE_ARCHIVE}.sha256")',
    );
    expect(verify).toContain('node scripts/release-payload-signature.mjs sign');
    const attestation = steps.find(
      (step) => step.name === 'Attest corresponding source provenance',
    );
    expect(attestation.with['subject-path']).toContain(
      '-corresponding-source.tar.gz\n',
    );
    expect(attestation.with['subject-path']).toContain(
      '-corresponding-source.tar.gz.sha256',
    );
    expect(
      steps.find((step) => step.name === 'Upload workflow artifacts').with.path,
    ).toContain('${{ runner.temp }}/otto-corresponding-source/output/*');
    const restagers = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.run?.includes('copy_one latest.json'));
    expect(restagers).toHaveLength(3);
    for (const step of restagers) {
      expect(step.run).toContain(
        'copy_one "otto-${VERSION}-corresponding-source.tar.gz"',
      );
      expect(step.run).toContain(
        'copy_one "otto-${VERSION}-corresponding-source.tar.gz.sha256"',
      );
      expect(step.run).not.toContain('=14');
      expect(step.run).not.toContain('= 14');
    }
    const desktopVector =
      verify.match(/DESKTOP_FILES=\([\s\S]*?\n\)/)?.[0] ??
      verify.slice(
        verify.indexOf('DESKTOP_FILES=('),
        verify.indexOf('FILES=("${DESKTOP_FILES[@]}"'),
      );
    expect(desktopVector).not.toContain('corresponding-source');
    expect(verify).toContain('${DESKTOP_FILES[@]:0:6}');
  });
});
