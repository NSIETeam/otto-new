/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Provider-neutral credential custody for QR-installed channels. Encryption is
 * supplied by the host (Electron safeStorage, KMS, HSM, etc.); this registry
 * owns atomic persistence, idempotency and tenant-bound reads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChannelInstallation, ChannelProvider } from './channelConnector.js';

export interface ChannelCredentialProtectorV1 {
  protect(plaintext: string): string | Promise<string>;
  unprotect(protectedValue: string): string | Promise<string>;
}

interface StoredChannelCredentialV1 {
  schemaVersion: 1;
  installation: ChannelInstallation;
  protectedCredential: string;
  committedAtMs: number;
}

interface StoredChannelCredentialRegistryV1 {
  schemaVersion: 1;
  entries: Record<string, StoredChannelCredentialV1>;
}

export interface ChannelCredentialLookup {
  installationId: string;
  provider: ChannelProvider;
  tenantId: string;
}

const INSTALLATION_ID_PATTERN = /^channel_(feishu|lark|wecom)_[a-f0-9]{24}$/;

function sameInstallation(
  left: ChannelInstallation,
  right: ChannelInstallation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class JsonChannelCredentialVaultV1 {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly protector: ChannelCredentialProtectorV1,
    private readonly now: () => number = Date.now,
  ) {}

  async commit(
    installation: Readonly<ChannelInstallation>,
    plaintextCredential: string,
  ): Promise<void> {
    if (!INSTALLATION_ID_PATTERN.test(installation.installationId)) {
      throw new Error('invalid channel installation id');
    }
    if (!plaintextCredential) throw new Error('channel credential is required');
    const operation = this.writeTail.then(async () => {
      const registry = this.readRegistry();
      const existing = registry.entries[installation.installationId];
      if (existing) {
        if (!sameInstallation(existing.installation, installation as ChannelInstallation)) {
          throw new Error('channel installation idempotency conflict');
        }
        return;
      }
      const protectedCredential = await this.protector.protect(plaintextCredential);
      if (!protectedCredential || protectedCredential === plaintextCredential) {
        throw new Error('channel credential protector returned unsafe output');
      }
      registry.entries[installation.installationId] = {
        schemaVersion: 1,
        installation: {
          ...installation,
          grantedScopes: [...installation.grantedScopes],
        },
        protectedCredential,
        committedAtMs: this.now(),
      };
      this.writeRegistry(registry);
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  async loadCredential(lookup: ChannelCredentialLookup): Promise<string> {
    await this.writeTail;
    const entry = this.readRegistry().entries[lookup.installationId];
    if (!entry) throw new Error('channel installation was not found');
    if (
      entry.installation.provider !== lookup.provider ||
      entry.installation.tenantId !== lookup.tenantId
    ) {
      throw new Error('channel installation tenant mismatch');
    }
    return this.protector.unprotect(entry.protectedCredential);
  }

  async remove(lookup: ChannelCredentialLookup): Promise<boolean> {
    const operation = this.writeTail.then(() => {
      const registry = this.readRegistry();
      const entry = registry.entries[lookup.installationId];
      if (!entry) return false;
      if (
        entry.installation.provider !== lookup.provider ||
        entry.installation.tenantId !== lookup.tenantId
      ) {
        throw new Error('channel installation tenant mismatch');
      }
      delete registry.entries[lookup.installationId];
      this.writeRegistry(registry);
      return true;
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  listInstallations(): ChannelInstallation[] {
    return Object.values(this.readRegistry().entries).map((entry) => ({
      ...entry.installation,
      grantedScopes: [...entry.installation.grantedScopes],
    }));
  }

  private readRegistry(): StoredChannelCredentialRegistryV1 {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as StoredChannelCredentialRegistryV1;
      if (parsed.schemaVersion !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
        throw new Error('invalid channel credential registry');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, entries: {} };
      }
      throw error;
    }
  }

  private writeRegistry(registry: StoredChannelCredentialRegistryV1): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(registry)}\n`, {
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup; preserve the original write/rename outcome.
      }
    }
  }
}
