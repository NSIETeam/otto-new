/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
/** Explicit development workspace marker; never a production enable flag. */
export function localMarketAcceptance(
  directory: string,
  environment: Record<string, string | undefined> = process.env,
) {
  if (
    environment.NODE_ENV === 'production' ||
    environment.OTTO_MARKET_LOCAL_ACCEPTANCE !== '1'
  )
    return false;
  try {
    const real = realpathSync(directory);
    if (!basename(real).startsWith('otto-market-acceptance-')) return false;
    const marker = JSON.parse(
      readFileSync(join(real, '.otto-market-acceptance.json'), 'utf8'),
    );
    return (
      marker.version === 1 && marker.purpose === 'isolated-local-acceptance'
    );
  } catch {
    return false;
  }
}
export async function assertLocalMarketPostgres(
  row: { local_socket?: unknown; data_directory?: unknown },
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (
    row.local_socket !== true ||
    typeof row.data_directory !== 'string' ||
    !localMarketAcceptance(row.data_directory, environment)
  )
    throw new Error('PostgreSQL must be an isolated local acceptance cluster');
}
export function createMarketReadiness(input: {
  localAcceptance: boolean;
  probes: Record<string, () => Promise<void>>;
}) {
  const checks = new Map(
    Object.keys(input.probes).map((name) => [name, false]),
  );
  let active = false;
  let pending: Promise<void> | undefined;
  return {
    worker(value: boolean) {
      active = value;
    },
    initialize() {
      if (pending) return pending;
      pending = (async () => {
        for (const [name, probe] of Object.entries(input.probes)) {
          try {
            await probe();
            checks.set(name, true);
          } catch {
            checks.set(name, false);
          }
        }
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    status() {
      const blocked = [...checks].filter(([, ok]) => !ok).map(([name]) => name);
      if (!active) blocked.push('maintenance-worker');
      if (!input.localAcceptance) blocked.push('production-release');
      return {
        protocol: 'park_flea_market_protocol_v1',
        mode: input.localAcceptance
          ? 'isolated-local-acceptance'
          : 'production-closed',
        ready: blocked.length === 0,
        blocked,
      };
    },
  };
}
