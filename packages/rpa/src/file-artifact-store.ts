/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RpaArtifact } from './contracts.js';
import type { RpaArtifactStore } from './ports.js';

function extensionFor(mediaType: string): string {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'application/json') return 'json';
  return 'bin';
}

/** Content-addressed, local-only artifact storage. Raw output never enters run records. */
export interface FileRpaArtifactStoreLimits {
  maxTotalBytes?: number;
  maxArtifacts?: number;
  /** Testable system-I/O seams; production uses node:fs/promises. */
  writeFile?: typeof writeFile;
  rename?: typeof rename;
}

export class FileRpaArtifactStore implements RpaArtifactStore {
  private readonly maxTotalBytes: number;
  private readonly maxArtifacts: number;
  private readonly writeFileImpl: typeof writeFile;
  private readonly renameImpl: typeof rename;
  private writeTail: Promise<void> = Promise.resolve();
  private usage?: { artifacts: number; bytes: number };

  constructor(
    private readonly rootDir: string,
    private readonly maxArtifactBytes = 10 * 1024 * 1024,
    limits: FileRpaArtifactStoreLimits = {},
  ) {
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
      throw new Error('RPA artifact byte limit is invalid.');
    }
    this.maxTotalBytes = limits.maxTotalBytes ?? 512 * 1024 * 1024;
    this.maxArtifacts = limits.maxArtifacts ?? 10_000;
    this.writeFileImpl = limits.writeFile ?? writeFile;
    this.renameImpl = limits.rename ?? rename;
    if (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < this.maxArtifactBytes) {
      throw new Error('RPA artifact store byte limit is invalid.');
    }
    if (!Number.isSafeInteger(this.maxArtifacts) || this.maxArtifacts < 1 || this.maxArtifacts > 100_000) {
      throw new Error('RPA artifact store count limit is invalid.');
    }
  }

  async put(input: { mediaType: string; bytes: Uint8Array; redactedSummary: string }): Promise<RpaArtifact> {
    if (!/^[a-z]+\/[a-z0-9.+-]+$/iu.test(input.mediaType)) throw new Error('RPA artifact media type is invalid.');
    if (input.bytes.byteLength > this.maxArtifactBytes) {
      throw new Error(`RPA artifact exceeds ${this.maxArtifactBytes} bytes.`);
    }
    let result!: RpaArtifact;
    const pending = this.writeTail.then(async () => {
      result = await this.putExclusive(input);
    });
    this.writeTail = pending.catch(() => undefined);
    await pending;
    return result;
  }

  private async putExclusive(input: {
    mediaType: string;
    bytes: Uint8Array;
    redactedSummary: string;
  }): Promise<RpaArtifact> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const usage = await this.loadUsage();
    if (usage.artifacts >= this.maxArtifacts) {
      throw new Error(`RPA artifact store reached its ${this.maxArtifacts} file limit.`);
    }
    if (usage.bytes + input.bytes.byteLength > this.maxTotalBytes) {
      throw new Error(`RPA artifact store exceeds its ${this.maxTotalBytes} byte limit.`);
    }
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const id = `artifact-${randomUUID()}`;
    const target = path.join(this.rootDir, `${id}.${extensionFor(input.mediaType)}`);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await this.writeFileImpl(temporary, input.bytes, { mode: 0o600 });
      await this.renameImpl(temporary, target);
      usage.artifacts += 1;
      usage.bytes += input.bytes.byteLength;
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

  private async loadUsage(): Promise<{ artifacts: number; bytes: number }> {
    if (this.usage) return this.usage;
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const artifacts = entries.filter((entry) => entry.isFile() && /^artifact-[0-9a-f-]+\.(?:png|json|bin)$/u.test(entry.name));
    let bytes = 0;
    for (const artifact of artifacts) bytes += (await stat(path.join(this.rootDir, artifact.name))).size;
    this.usage = { artifacts: artifacts.length, bytes };
    return this.usage;
  }
}
