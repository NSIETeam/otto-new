/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
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
import {
  HEIC_SOURCE_INPUTS,
  readVerifiedCache,
  sha256,
} from './heic-corresponding-source.mjs';

const marker = 'otto-lgpl-active-wrapper-recombined-v1';
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
export function probeHeicRecombination(cacheDir) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'otto-heic-recombination-'));
  const identity = realpathSync(temp);
  try {
    const archives = new Map();
    for (const name of [
      'heic-decode-2.1.0-npm.tgz',
      'libheif-js-1.23.2-npm.tgz',
      'libheif-1.23.2-source.tar.gz',
    ]) {
      const spec = HEIC_SOURCE_INPUTS.find((input) => input.file === name);
      const bytes = readVerifiedCache(cacheDir, spec);
      requireThat(bytes, `verified source cache is missing ${name}`);
      // Copy the verified buffer first, preventing a subsequent cache change from changing the extracted code.
      const archive = path.join(temp, name);
      writeFileSync(archive, bytes, { flag: 'wx' });
      archives.set(name, archive);
    }
    const extract = (name, member) =>
      execFileSync('tar', ['-xOzf', archives.get(name), member], {
        maxBuffer: 16 * 1024 * 1024,
      });
    for (const [name, archive, files] of [
      [
        'heic-decode',
        'heic-decode-2.1.0-npm.tgz',
        ['package.json', 'index.js', 'lib.js'],
      ],
      [
        'libheif-js',
        'libheif-js-1.23.2-npm.tgz',
        ['package.json', 'wasm-bundle.js', 'libheif-wasm/libheif-bundle.js'],
      ],
    ]) {
      for (const file of files) {
        const target = path.join(temp, 'node_modules', name, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, extract(archive, `package/${file}`), {
          flag: 'wx',
        });
      }
    }
    const example = extract(
      'libheif-1.23.2-source.tar.gz',
      'libheif-ac1cb05c39008f01525c991ff8b88f84ddf70fd2/examples/example.heic',
    );
    writeFileSync(path.join(temp, 'example.heic'), example, { flag: 'wx' });
    writeFileSync(path.join(temp, 'invalid.heic'), example.subarray(0, 12), {
      flag: 'wx',
    });
    const probe = path.join(temp, 'probe.cjs');
    writeFileSync(
      probe,
      `const fs=require('node:fs');const crypto=require('node:crypto');const decode=require('heic-decode');
(async()=>{const image=await decode({buffer:fs.readFileSync(process.argv[2])});
const wrapper=require('libheif-js/wasm-bundle');
console.log(JSON.stringify({width:image.width,height:image.height,bytes:image.data.length,pixelsSha256:crypto.createHash('sha256').update(image.data).digest('hex'),marker:wrapper.__ottoRecombinationMarker??null}));
})().catch(()=>{process.exitCode=1;});\n`,
      { flag: 'wx' },
    );
    const run = (file = 'example.heic') =>
      spawnSync(
        process.execPath,
        ['--max-old-space-size=256', probe, path.join(temp, file)],
        {
          cwd: temp,
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, NODE_OPTIONS: '' },
        },
      );
    const decode = () => {
      const result = run();
      requireThat(result.status === 0, 'real HEIC decode failed');
      const pixels = JSON.parse(result.stdout);
      requireThat(
        pixels.width > 0 &&
          pixels.height > 0 &&
          pixels.bytes === pixels.width * pixels.height * 4 &&
          /^[a-f0-9]{64}$/.test(pixels.pixelsSha256),
        'real HEIC decode returned invalid pixels',
      );
      return pixels;
    };
    const baseline = decode();
    requireThat(
      baseline.marker === null,
      'control wrapper unexpectedly modified',
    );
    // Negative control: this binary file is not used by the active embedded-WASM entry point.
    writeFileSync(
      path.join(temp, 'node_modules/libheif-js/libheif-wasm/libheif.wasm'),
      'deliberately not valid wasm',
      { flag: 'wx' },
    );
    const unusedWasm = decode();
    requireThat(
      JSON.stringify(unusedWasm) === JSON.stringify(baseline),
      'unused WASM control changed active decoding',
    );
    const wrapper = path.join(temp, 'node_modules/libheif-js/wasm-bundle.js');
    const original = readFileSync(wrapper);
    const modified = Buffer.concat([
      original,
      Buffer.from(
        `\nmodule.exports.__ottoRecombinationMarker=${JSON.stringify(marker)};\n`,
      ),
    ]);
    writeFileSync(wrapper, modified);
    const recombined = decode();
    requireThat(
      recombined.marker === marker &&
        JSON.stringify({ ...recombined, marker: null }) ===
          JSON.stringify(baseline),
      'active replacement not observed or decoded pixels changed',
    );
    const invalid = run('invalid.heic');
    requireThat(invalid.status === 1, 'truncated HEIC must still be rejected');
    return {
      schemaVersion: 1,
      exampleSha256: sha256(example),
      originalWrapperSha256: sha256(original),
      recombinedWrapperSha256: sha256(modified),
      baseline,
      recombined,
      unusedWasmDoesNotReplaceActiveLibrary: true,
      truncatedInputRejected: true,
      wasmRecompiled: false,
      installedDesktopValidated: false,
    };
  } finally {
    requireThat(
      realpathSync(temp) === identity &&
        path.basename(temp).startsWith('otto-heic-recombination-') &&
        path.dirname(identity) === realpathSync(os.tmpdir()),
      'unsafe recombination cleanup',
    );
    rmSync(temp, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 4 || process.argv[2] !== '--cache-dir')
    throw new Error('usage: --cache-dir <verified-source-cache>');
  process.stdout.write(
    `${JSON.stringify(probeHeicRecombination(process.argv[3]))}\n`,
  );
}
