/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Durable, revision-checked bindings between provider identities and Otto
 * principals. This store contains identifiers only; channel credentials stay
 * in the credential vault.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChannelProvider } from './channelConnector.js';
import type {
  BoundChannelIdentity,
  ChannelIdentityResolverV1,
} from './brokerChannelTaskBridge.js';

export interface ChannelIdentityBindingV1 {
  provider: ChannelProvider;
  installationId: string;
  tenantId: string;
  providerUserId: string;
  canonicalUserId: string;
  active: boolean;
  revision: number;
  approvalId: string;
  approvedBy: string;
  boundAtMs: number;
  updatedAtMs: number;
}

export interface ChannelIdentityBindingInput {
  provider: ChannelProvider;
  installationId: string;
  tenantId: string;
  providerUserId: string;
  canonicalUserId: string;
  approvalId: string;
  approvedBy: string;
  expectedRevision: number;
}

export type ChannelIdentityAuditEvent = {
  action: 'bound' | 'revoked';
  provider: ChannelProvider;
  installationId: string;
  tenantId: string;
  providerUserId: string;
  canonicalUserId: string;
  revision: number;
  approvalId: string;
  approvedBy: string;
  occurredAtMs: number;
};

interface RegistryFileV1 {
  version: 1;
  bindings: ChannelIdentityBindingV1[];
}

export interface JsonChannelIdentityRegistryOptions {
  filePath?: string;
  now?: () => number;
  audit: (event: Readonly<ChannelIdentityAuditEvent>) => void | Promise<void>;
}

export interface ChannelIdentityRegistryV1 extends ChannelIdentityResolverV1 {
  list(installationId?: string): ChannelIdentityBindingV1[];
  bind(input: ChannelIdentityBindingInput): Promise<ChannelIdentityBindingV1>;
  revoke(input: {
    provider: ChannelProvider;
    installationId: string;
    tenantId: string;
    providerUserId: string;
    approvalId: string;
    approvedBy: string;
    expectedRevision: number;
  }): Promise<ChannelIdentityBindingV1>;
}

export function createJsonChannelIdentityAuditSink(filePath?: string) {
  const target = filePath ?? path.join(
    process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user'),
    'channel-identity-audit.jsonl',
  );
  return async (event: Readonly<ChannelIdentityAuditEvent>): Promise<void> => {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.appendFileSync(target, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(target, 0o600);
  };
}

const PROVIDERS = new Set<ChannelProvider>(['feishu', 'lark', 'wecom', 'dingtalk']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,199}$/u;

function defaultPath(): string {
  const userDir = process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user');
  return path.join(userDir, 'channel-identity-bindings.json');
}

function validateId(value: string, label: string): string {
  const clean = value.trim();
  if (!IDENTIFIER.test(clean)) throw new Error(`${label} is invalid`);
  return clean;
}

function bindingKey(input: Pick<ChannelIdentityBindingV1,
  'provider' | 'installationId' | 'tenantId' | 'providerUserId'>): string {
  return JSON.stringify([input.provider, input.installationId, input.tenantId, input.providerUserId]);
}

function clone(binding: ChannelIdentityBindingV1): ChannelIdentityBindingV1 {
  return { ...binding };
}

export class JsonChannelIdentityRegistryV1 implements ChannelIdentityRegistryV1 {
  private readonly bindings = new Map<string, ChannelIdentityBindingV1>();
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(private readonly options: JsonChannelIdentityRegistryOptions) {
    this.filePath = options.filePath ?? defaultPath();
    this.now = options.now ?? Date.now;
    this.load();
  }

  list(installationId?: string): ChannelIdentityBindingV1[] {
    return [...this.bindings.values()]
      .filter((binding) => !installationId || binding.installationId === installationId)
      .map(clone)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  async resolve(input: {
    provider: ChannelProvider;
    installationId: string;
    tenantId: string;
    providerUserId: string;
  }): Promise<BoundChannelIdentity | null> {
    const normalized = this.normalizeLookup(input);
    const binding = this.bindings.get(bindingKey(normalized));
    if (!binding) return null;
    return { canonicalUserId: binding.canonicalUserId, active: binding.active };
  }

  async bind(input: ChannelIdentityBindingInput): Promise<ChannelIdentityBindingV1> {
    const normalized = this.normalizeBinding(input);
    const key = bindingKey(normalized);
    const existing = this.bindings.get(key);
    const revision = existing?.revision ?? 0;
    if (normalized.expectedRevision !== revision) {
      throw new Error(`channel identity binding revision conflict (current ${revision})`);
    }
    const timestamp = this.now();
    const binding: ChannelIdentityBindingV1 = {
      provider: normalized.provider,
      installationId: normalized.installationId,
      tenantId: normalized.tenantId,
      providerUserId: normalized.providerUserId,
      canonicalUserId: normalized.canonicalUserId,
      active: true,
      revision: revision + 1,
      approvalId: normalized.approvalId,
      approvedBy: normalized.approvedBy,
      boundAtMs: existing?.boundAtMs ?? timestamp,
      updatedAtMs: timestamp,
    };
    this.bindings.set(key, binding);
    try {
      this.flush();
      await this.options.audit({ action: 'bound', ...binding, occurredAtMs: timestamp });
    } catch (error) {
      if (existing) this.bindings.set(key, existing); else this.bindings.delete(key);
      this.flush();
      throw error;
    }
    return clone(binding);
  }

  async revoke(input: {
    provider: ChannelProvider;
    installationId: string;
    tenantId: string;
    providerUserId: string;
    approvalId: string;
    approvedBy: string;
    expectedRevision: number;
  }): Promise<ChannelIdentityBindingV1> {
    const normalized = this.normalizeLookup(input);
    const approvalId = validateId(input.approvalId, 'approvalId');
    const approvedBy = validateId(input.approvedBy, 'approvedBy');
    const key = bindingKey(normalized);
    const existing = this.bindings.get(key);
    if (!existing) throw new Error('channel identity binding was not found');
    if (input.expectedRevision !== existing.revision) {
      throw new Error(`channel identity binding revision conflict (current ${existing.revision})`);
    }
    const timestamp = this.now();
    const binding: ChannelIdentityBindingV1 = {
      ...existing,
      active: false,
      revision: existing.revision + 1,
      approvalId,
      approvedBy,
      updatedAtMs: timestamp,
    };
    this.bindings.set(key, binding);
    try {
      this.flush();
      await this.options.audit({ action: 'revoked', ...binding, occurredAtMs: timestamp });
    } catch (error) {
      this.bindings.set(key, existing);
      this.flush();
      throw error;
    }
    return clone(binding);
  }

  private normalizeLookup(input: {
    provider: ChannelProvider;
    installationId: string;
    tenantId: string;
    providerUserId: string;
  }) {
    if (!PROVIDERS.has(input.provider)) throw new Error('provider is invalid');
    return {
      provider: input.provider,
      installationId: validateId(input.installationId, 'installationId'),
      tenantId: validateId(input.tenantId, 'tenantId'),
      providerUserId: validateId(input.providerUserId, 'providerUserId'),
    };
  }

  private normalizeBinding(input: ChannelIdentityBindingInput) {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('expectedRevision is invalid');
    }
    return {
      ...this.normalizeLookup(input),
      canonicalUserId: validateId(input.canonicalUserId, 'canonicalUserId'),
      approvalId: validateId(input.approvalId, 'approvalId'),
      approvedBy: validateId(input.approvedBy, 'approvedBy'),
      expectedRevision: input.expectedRevision,
    };
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RegistryFileV1;
      if (parsed.version !== 1 || !Array.isArray(parsed.bindings) || parsed.bindings.length > 100_000) {
        throw new Error('unsupported channel identity registry');
      }
      for (const candidate of parsed.bindings) {
        const lookup = this.normalizeLookup(candidate);
        validateId(candidate.canonicalUserId, 'canonicalUserId');
        validateId(candidate.approvalId, 'approvalId');
        validateId(candidate.approvedBy, 'approvedBy');
        if (typeof candidate.active !== 'boolean' || !Number.isSafeInteger(candidate.revision)
          || candidate.revision < 1 || !Number.isFinite(candidate.boundAtMs)
          || !Number.isFinite(candidate.updatedAtMs)) throw new Error('invalid channel identity binding');
        const key = bindingKey(lookup);
        if (this.bindings.has(key)) throw new Error('duplicate channel identity binding');
        this.bindings.set(key, clone(candidate));
      }
    } catch (error) {
      const quarantine = `${this.filePath}.corrupt-${this.now()}`;
      try { fs.renameSync(this.filePath, quarantine); } catch { /* preserve suspect file */ }
      this.bindings.clear();
      throw new Error(`channel identity registry was corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private flush(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      const payload: RegistryFileV1 = { version: 1, bindings: [...this.bindings.values()] };
      fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      throw error;
    }
  }
}
