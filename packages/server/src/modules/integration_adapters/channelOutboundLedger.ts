/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChannelProvider } from './channelConnector.js';

export type ChannelOutboundState = 'prepared' | 'failed' | 'committed';

export interface ChannelOutboundReceipt {
  idempotencyKey: string;
  providerMessageId: string;
  committedAtMs: number;
}

export interface ChannelOutboundRecord {
  idempotencyKey: string;
  installationId: string;
  provider: ChannelProvider;
  requestHash: string;
  state: ChannelOutboundState;
  attempts: number;
  updatedAtMs: number;
  receipt?: ChannelOutboundReceipt;
  failureCode?: string;
}

export interface ChannelOutboundLedgerV1 {
  prepare(input: {
    idempotencyKey: string;
    installationId: string;
    provider: ChannelProvider;
    requestHash: string;
  }): Promise<ChannelOutboundRecord>;
  commit(
    idempotencyKey: string,
    requestHash: string,
    providerMessageId: string,
  ): Promise<ChannelOutboundRecord>;
  fail(
    idempotencyKey: string,
    requestHash: string,
    failureCode: string,
  ): Promise<ChannelOutboundRecord>;
}

interface RegistryV1 {
  schemaVersion: 1;
  records: Record<string, ChannelOutboundRecord>;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class JsonChannelOutboundLedgerV1 implements ChannelOutboundLedgerV1 {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(input: {
    idempotencyKey: string;
    installationId: string;
    provider: ChannelProvider;
    requestHash: string;
  }): Promise<ChannelOutboundRecord> {
    this.validate(input.idempotencyKey, input.requestHash);
    return this.write((registry) => {
      const existing = registry.records[input.idempotencyKey];
      if (existing) {
        this.assertSameRequest(existing, input.requestHash);
        if (existing.installationId !== input.installationId || existing.provider !== input.provider) {
          throw new Error('channel outbound idempotency conflict');
        }
        if (existing.state !== 'committed') {
          existing.state = 'prepared';
          existing.attempts += 1;
          existing.updatedAtMs = this.now();
          delete existing.failureCode;
        }
        return existing;
      }
      const record: ChannelOutboundRecord = {
        ...input,
        state: 'prepared',
        attempts: 1,
        updatedAtMs: this.now(),
      };
      registry.records[input.idempotencyKey] = record;
      return record;
    });
  }

  async commit(
    idempotencyKey: string,
    requestHash: string,
    providerMessageId: string,
  ): Promise<ChannelOutboundRecord> {
    this.validate(idempotencyKey, requestHash);
    if (!providerMessageId.trim() || providerMessageId.length > 500) {
      throw new Error('provider message id is invalid');
    }
    return this.write((registry) => {
      const record = this.requireRecord(registry, idempotencyKey, requestHash);
      if (record.state === 'committed') {
        if (record.receipt?.providerMessageId !== providerMessageId) {
          throw new Error('channel outbound commit conflict');
        }
        return record;
      }
      record.state = 'committed';
      record.updatedAtMs = this.now();
      record.receipt = {
        idempotencyKey,
        providerMessageId: providerMessageId.trim(),
        committedAtMs: this.now(),
      };
      delete record.failureCode;
      return record;
    });
  }

  async fail(
    idempotencyKey: string,
    requestHash: string,
    failureCode: string,
  ): Promise<ChannelOutboundRecord> {
    this.validate(idempotencyKey, requestHash);
    return this.write((registry) => {
      const record = this.requireRecord(registry, idempotencyKey, requestHash);
      if (record.state === 'committed') return record;
      record.state = 'failed';
      record.updatedAtMs = this.now();
      record.failureCode = failureCode.trim().slice(0, 100) || 'unknown';
      return record;
    });
  }

  private validate(idempotencyKey: string, requestHash: string): void {
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new Error('channel outbound idempotency key is invalid');
    }
    if (!HASH_PATTERN.test(requestHash)) throw new Error('channel outbound request hash is invalid');
  }

  private assertSameRequest(record: ChannelOutboundRecord, requestHash: string): void {
    if (record.requestHash !== requestHash) throw new Error('channel outbound idempotency conflict');
  }

  private requireRecord(
    registry: RegistryV1,
    idempotencyKey: string,
    requestHash: string,
  ): ChannelOutboundRecord {
    const record = registry.records[idempotencyKey];
    if (!record) throw new Error('channel outbound write was not prepared');
    this.assertSameRequest(record, requestHash);
    return record;
  }

  private async write<T>(operation: (registry: RegistryV1) => T): Promise<T> {
    let result!: T;
    const pending = this.writeTail.then(() => {
      const registry = this.read();
      result = operation(registry);
      this.persist(registry);
    });
    this.writeTail = pending.catch(() => undefined);
    await pending;
    return structuredClone(result);
  }

  private read(): RegistryV1 {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RegistryV1;
      if (parsed.schemaVersion !== 1 || !parsed.records || typeof parsed.records !== 'object') {
        throw new Error('invalid channel outbound ledger');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, records: {} };
      }
      throw error;
    }
  }

  private persist(registry: RegistryV1): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      try { fs.unlinkSync(temporaryPath); } catch {}
    }
  }
}
