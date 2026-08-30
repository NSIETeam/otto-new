/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RpaArtifact } from './contracts.js';
import type { RpaArtifactStore } from './ports.js';

function extensionFor(mediaType: string): string {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'application/json') return 'json';
  return 'bin';
}

/** Content-addressed, local-only artifact storage. Raw output never enters run records. */
export class FileRpaArtifactStore implements RpaArtifactStore {
  constructor(
    private readonly rootDir: string,
    private readonly maxArtifactBytes = 10 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
      throw new Error('RPA artifact byte limit is invalid.');
    }
  }

  async put(input: { mediaType: string; bytes: Uint8Array; redactedSummary: string }): Promise<RpaArtifact> {
    if (!/^[a-z]+\/[a-z0-9.+-]+$/iu.test(input.mediaType)) throw new Error('RPA artifact media type is invalid.');
    if (input.bytes.byteLength > this.maxArtifactBytes) {
      throw new Error(`RPA artifact exceeds ${this.maxArtifactBytes} bytes.`);
    }
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const id = `artifact-${randomUUID()}`;
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.rootDir, `${id}.${extensionFor(input.mediaType)}`);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, input.bytes, { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      id,
      sha256,
      mediaType: input.mediaType,
      redactedSummary: input.redactedSummary.replace(/[\r\n\t]+/gu, ' ').slice(0, 500),
    };
  }
}
