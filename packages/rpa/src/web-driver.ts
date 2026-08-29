/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RpaDriver } from './ports.js';

export interface RpaWebPage {
  goto(url: string, options: { waitUntil: 'networkidle'; timeout: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  screenshot(options: { fullPage: boolean }): Promise<Uint8Array>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<void>;
  route(pattern: string, handler: (route: RpaWebRoute) => Promise<void>): Promise<void>;
}

export interface RpaWebRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}

export interface RpaNavigationPolicy {
  authorize(url: URL): Promise<void>;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (!isIP(normalized)) return false;
  return /^(?:127|0)\./u.test(normalized) || /^10\./u.test(normalized)
    || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(normalized)
    || /^192\.168\./u.test(normalized) || /^169\.254\./u.test(normalized)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(normalized);
}

const DEFAULT_NAVIGATION_POLICY: RpaNavigationPolicy = {
  async authorize(url): Promise<void> {
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new Error('RPA navigation blocks local and private network targets.');
    }
    const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('RPA navigation blocks local and private network targets.');
    }
  },
};

export interface RpaWebSession {
  page: RpaWebPage;
  close(): Promise<void>;
}

export interface RpaWebSessionFactory {
  create(): Promise<RpaWebSession>;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`RPA web action requires ${name}.`);
  return value;
}

function timeout(args: Record<string, unknown>): number {
  const value = args['timeoutMs'];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 60_000 ? value : 15_000;
}

function safeUrl(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('RPA web navigation only accepts credential-free HTTP(S) URLs.');
  }
  return parsed.toString();
}

function hostIsDeclared(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalized = hostname.toLowerCase();
  return allowedHosts.some((candidate) => {
    const rule = candidate.trim().toLowerCase();
    if (rule.startsWith('*.')) return normalized.endsWith(rule.slice(1)) && normalized !== rule.slice(2);
    return normalized === rule;
  });
}

/** Maintains one browser context per RPA run instead of starting Chromium for every action. */
export class RunScopedWebDriver implements RpaDriver {
  private readonly sessions = new Map<string, RpaWebSession>();

  constructor(
    private readonly factory: RpaWebSessionFactory,
    private readonly navigationPolicy: RpaNavigationPolicy = DEFAULT_NAVIGATION_POLICY,
  ) {}

  async execute(input: Parameters<RpaDriver['execute']>[0]): ReturnType<RpaDriver['execute']> {
    const { action, args } = input.step;
    const wait = timeout(args);
    switch (action) {
      case 'web.navigate': {
        const url = safeUrl(requiredString(args, 'url'));
        const parsed = new URL(url);
        const allowedHosts = input.run.workflow.allowedHosts ?? [];
        if (!hostIsDeclared(parsed.hostname, allowedHosts)) {
          throw new Error(`RPA navigation domain is not declared: ${parsed.hostname}`);
        }
        await this.navigationPolicy.authorize(parsed);
        if (input.signal?.aborted) throw input.signal.reason ?? new Error('RPA run was cancelled.');
        const session = await this.sessionFor(input.run.id, true, allowedHosts);
        await session.page.goto(url, { waitUntil: 'networkidle', timeout: wait });
        return { output: { url } };
      }
      case 'web.fill': {
        const session = await this.sessionFor(input.run.id);
        await session.page.fill(requiredString(args, 'selector'), requiredString(args, 'value'));
        return { output: { filled: true } };
      }
      case 'web.click': {
        const session = await this.sessionFor(input.run.id);
        await session.page.click(requiredString(args, 'selector'));
        return { output: { clicked: true } };
      }
      case 'web.extract': {
        const session = await this.sessionFor(input.run.id);
        const text = await session.page.textContent(requiredString(args, 'selector'));
        return { output: { text: text ?? '' } };
      }
      case 'web.screenshot': {
        const session = await this.sessionFor(input.run.id);
        const bytes = await session.page.screenshot({ fullPage: args['fullPage'] === true });
        return {
          output: { captured: true },
          artifacts: [{ mediaType: 'image/png', bytes, redactedSummary: 'RPA page screenshot' }],
        };
      }
      case 'web.wait': {
        const session = await this.sessionFor(input.run.id);
        await session.page.waitForSelector(requiredString(args, 'selector'), { timeout: wait });
        return { output: { ready: true } };
      }
      case 'checkpoint':
        return { output: { checkpoint: input.idempotencyKey } };
      default:
        throw new Error(`Unsupported RPA action: ${action}`);
    }
  }

  async closeRun(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return;
    this.sessions.delete(runId);
    await session.close();
  }

  private async sessionFor(runId: string, createForNavigation = false, allowedHosts: readonly string[] = []): Promise<RpaWebSession> {
    const existing = this.sessions.get(runId);
    if (existing) return existing;
    if (!createForNavigation) {
      throw new Error('RPA browser context is unavailable for this run. Resume from a web.navigate checkpoint; do not replay a page action in a new blank session.');
    }
    const created = await this.factory.create();
    await created.page.route('**/*', async (route) => {
      try {
        const requested = new URL(route.request().url());
        if (!hostIsDeclared(requested.hostname, allowedHosts)) throw new Error('domain is not declared');
        await this.navigationPolicy.authorize(requested);
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    this.sessions.set(runId, created);
    return created;
  }
}
