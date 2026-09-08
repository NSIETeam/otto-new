/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';

/** Shared by the executable smoke runner and the sealed experiment manifest. */
export const LIVE_EVAL_EXECUTION_LIMITS = Object.freeze({
  maxOutputTokens: 2048,
  maxRounds: 10,
  maxCaseMs: 150000,
  requestTimeoutMs: 45000,
  maxBatchRuns: 24,
  maxRepeats: 3,
  parallelism: 1,
});

/** Public metadata only. Never return the endpoint or credential. */
export function liveEvalPreflight(env: Record<string, string | undefined>) {
  const required = [
    'OTTO_LIVE_EVAL',
    'OTTO_EVAL_BASE_URL',
    'OTTO_EVAL_API_KEY',
    'OTTO_EVAL_MODEL',
    'OTTO_EVAL_MODEL_REVISION',
    'OTTO_EVAL_MAX_COST_USD',
    'OTTO_EVAL_CASE_COST_RESERVE_USD',
    'OTTO_EVAL_PROVIDER_CAP_CONFIRMED',
    'OTTO_EVAL_INPUT_PER_MILLION',
    'OTTO_EVAL_OUTPUT_PER_MILLION',
  ];
  const missing = required.filter((key) => !env[key]?.trim());
  const invalid: string[] = [];
  if (env.OTTO_LIVE_EVAL !== '1') invalid.push('explicit_opt_in_required');
  if (env.OTTO_EVAL_PROVIDER_CAP_CONFIRMED !== '1')
    invalid.push('provider_billing_cap_acknowledgment_required');
  let endpointHash: string | null = null;
  try {
    const endpoint = new URL(env.OTTO_EVAL_BASE_URL ?? '');
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.protocol !== 'https:' &&
        !(
          endpoint.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
        ))
    )
      throw new Error('unsafe');
    endpointHash = createHash('sha256').update(endpoint.href).digest('hex');
  } catch {
    invalid.push('unsafe_endpoint');
  }
  const model = env.OTTO_EVAL_MODEL?.trim() ?? '';
  const revision = env.OTTO_EVAL_MODEL_REVISION?.trim() ?? '';
  // This is a declared pin, not remote attestation. An alias can still drift;
  // record/verify the provider revision separately before a release decision.
  if (
    !model ||
    model !== revision ||
    /(?:^|[-_:])(?:auto|latest|preview)(?:$|[-_:])/iu.test(model) ||
    !/(?:20\d{2}-?\d{2}-?\d{2}|[a-f\d]{40,64})/iu.test(revision)
  )
    invalid.push('pinned_request_model_required');
  const maxCostUsd = Number(env.OTTO_EVAL_MAX_COST_USD);
  const reserveUsd = Number(env.OTTO_EVAL_CASE_COST_RESERVE_USD);
  const inputPerMillion = Number(env.OTTO_EVAL_INPUT_PER_MILLION);
  const outputPerMillion = Number(env.OTTO_EVAL_OUTPUT_PER_MILLION);
  if (
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd <= 0 ||
    !Number.isFinite(reserveUsd) ||
    reserveUsd <= 0 ||
    reserveUsd > maxCostUsd
  )
    invalid.push('invalid_cost_limits');
  if (
    ![inputPerMillion, outputPerMillion].every(
      (n) => Number.isFinite(n) && n >= 0,
    )
  )
    invalid.push('invalid_prices');
  const ready = missing.length === 0 && invalid.length === 0;
  // An offline protocol can pin public choices before receiving a credential.
  // This declaration never grants permission; the original live gate stays shut.
  const executionOnlyKeys = new Set([
    'OTTO_LIVE_EVAL',
    'OTTO_EVAL_API_KEY',
    'OTTO_EVAL_PROVIDER_CAP_CONFIRMED',
  ]);
  const declarationMissing = missing.filter(
    (key) => !executionOnlyKeys.has(key),
  );
  const declarationInvalid = invalid.filter(
    (reason) =>
      reason !== 'explicit_opt_in_required' &&
      reason !== 'provider_billing_cap_acknowledgment_required',
  );
  const publicNumber = (key: string, value: number) =>
    env[key]?.trim() && Number.isFinite(value) ? value : null;
  const declarationIdentity = {
    model: model || null,
    modelRevision: revision || null,
    endpointHash,
    maxCostUsd: publicNumber('OTTO_EVAL_MAX_COST_USD', maxCostUsd),
    reserveUsd: publicNumber('OTTO_EVAL_CASE_COST_RESERVE_USD', reserveUsd),
    inputPerMillion: publicNumber(
      'OTTO_EVAL_INPUT_PER_MILLION',
      inputPerMillion,
    ),
    outputPerMillion: publicNumber(
      'OTTO_EVAL_OUTPUT_PER_MILLION',
      outputPerMillion,
    ),
  };
  return {
    ready,
    missing,
    invalid,
    credentialConfigured: Boolean(env.OTTO_EVAL_API_KEY?.trim()),
    declaration: {
      ready: declarationMissing.length === 0 && declarationInvalid.length === 0,
      identity: declarationIdentity,
      fingerprint: createHash('sha256')
        .update(JSON.stringify(declarationIdentity))
        .digest('hex'),
      missing: declarationMissing,
      invalid: declarationInvalid,
    },
    identity: ready
      ? {
          model,
          modelRevision: revision,
          endpointHash: endpointHash!,
          maxCostUsd,
          reserveUsd,
          inputPerMillion,
          outputPerMillion,
        }
      : null,
    limitation:
      'Local estimated-cost reservations are not a provider billing cap or proof of remote model immutability.',
  };
}

/** Serial admission accounting; a reservation is not a guarantee on a running request's invoice. */
export class LiveEvalBudget {
  private nextId = 0;
  private pending = new Map<number, number>();
  private spent = 0;
  private unknown = false;
  private unresolved = 0;
  private stopReason: string | null = null;
  constructor(
    private readonly maxUsd: number,
    private readonly reserveUsd: number,
  ) {
    if (
      ![maxUsd, reserveUsd].every((n) => Number.isFinite(n) && n > 0) ||
      reserveUsd > maxUsd
    )
      throw new Error('Invalid budget');
  }
  reserve(): number | null {
    const reserved = [...this.pending.values()].reduce((a, b) => a + b, 0);
    if (
      this.stopReason ||
      this.spent + reserved + this.reserveUsd > this.maxUsd + Number.EPSILON
    )
      return null;
    const id = ++this.nextId;
    this.pending.set(id, this.reserveUsd);
    return id;
  }
  settle(id: number, estimatedUsd: number | null): void {
    const reserved = this.pending.get(id);
    if (reserved === undefined)
      throw new Error('Unknown or already settled reservation');
    if (
      estimatedUsd === null ||
      !Number.isFinite(estimatedUsd) ||
      estimatedUsd < 0
    ) {
      // Keep unresolved liability charged to the budget and halt further calls.
      this.unknown = true;
      this.stopReason = 'usage_or_cost_unknown';
      this.pending.delete(id);
      this.unresolved += reserved;
      return;
    }
    this.pending.delete(id);
    this.spent += estimatedUsd;
    if (estimatedUsd > reserved || this.spent > this.maxUsd)
      this.stopReason = 'case_reserve_exceeded';
  }
  snapshot() {
    return {
      maxUsd: this.maxUsd,
      caseReserveUsd: this.reserveUsd,
      reservedUsd:
        this.unresolved + [...this.pending.values()].reduce((a, b) => a + b, 0),
      actualEstimatedUsd: this.unknown ? null : this.spent,
      stopped: this.stopReason !== null,
      stopReason: this.stopReason,
    };
  }
}
