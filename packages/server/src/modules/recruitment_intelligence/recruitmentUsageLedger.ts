/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { Database, EncryptedFieldCipher, EncryptedFieldValue } from '../data_platform/index.js';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';

export interface RecruitmentOrganizationBudget { dailyRequests: number; dailyReservedTokens: number }
export interface RecruitmentOrganizationUsage extends RecruitmentOrganizationBudget {
  day: string; checkedAt: string; requests: number; reservedTokens: number; inputTokens: number; outputTokens: number; unknownRequests: number;
}
interface UsageDay { day: string; requests: number; reservedTokens: number; inputTokens: number; outputTokens: number; unknownRequests: number }
interface Receipt { key: string; runId: string; createdAt: number; day: string; status: 'reserved' | 'completed' | 'unknown' }
interface LedgerState { revision: number; days: UsageDay[]; receipts: Receipt[] }
export interface RecruitmentUsageStore {
  get(org: string): Promise<LedgerState | null>;
  compareAndSet(org: string, expected: number, state: LedgerState): Promise<boolean>;
}
function validBudget(value: RecruitmentOrganizationBudget): boolean {
  return Number.isSafeInteger(value.dailyRequests) && value.dailyRequests >= 1 && value.dailyRequests <= 500
    && Number.isSafeInteger(value.dailyReservedTokens) && value.dailyReservedTokens >= 10_000 && value.dailyReservedTokens <= 20_000_000;
}
export function readRecruitmentOrganizationBudget(org: string, env: NodeJS.ProcessEnv = process.env): RecruitmentOrganizationBudget | null {
  const raw = env.OTTO_RECRUITMENT_ORGANIZATION_BUDGETS;
  if (!raw || raw.length > 50_000 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(org)) return null;
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > 200) return null;
    const matches = entries.filter((entry) => entry && typeof entry === 'object' && entry.organizationId === org);
    if (matches.length !== 1 || !validBudget(matches[0])) return null;
    return { dailyRequests: matches[0].dailyRequests, dailyReservedTokens: matches[0].dailyReservedTokens };
  } catch { return null; }
}
const dayAt = (now: number): string => new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
const emptyDay = (day: string): UsageDay => ({ day, requests: 0, reservedTokens: 0, inputTokens: 0, outputTokens: 0, unknownRequests: 0 });
export type RecruitmentUsageReservation = { kind: 'reserved' } | { kind: 'duplicate'; runId: string; status: Receipt['status'] } | { kind: 'budget' | 'capacity' };

/** CAS includes BOTH request admission and the enterprise counter. No candidate text or model result is stored. */
export class RecruitmentUsageLedger {
  constructor(private readonly store: RecruitmentUsageStore, private readonly now: () => number = Date.now) {}
  async snapshot(org: string, budget: RecruitmentOrganizationBudget): Promise<RecruitmentOrganizationUsage> {
    const now = this.now(); const day = dayAt(now); const state = await this.store.get(org);
    return { ...budget, ...(state?.days.find((entry) => entry.day === day) ?? emptyDay(day)), checkedAt: new Date(now).toISOString() };
  }
  async reserve(org: string, budget: RecruitmentOrganizationBudget, input: { key: string; runId: string; reservedTokens: number }): Promise<RecruitmentUsageReservation> {
    if (!validBudget(budget) || !/^[a-f0-9]{64}$/u.test(input.key) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(input.runId)
      || !Number.isSafeInteger(input.reservedTokens) || input.reservedTokens < 1 || input.reservedTokens > 20_000_000) throw new Error('企业招聘额度请求无效，未调用模型');
    for (let retry = 0; retry < 40; retry++) {
      const now = this.now(); const day = dayAt(now); const old = await this.store.get(org) ?? { revision: 0, days: [], receipts: [] };
      // Settled metadata is compacted after 30 days. Uncertain attempts NEVER expire into permission to retry.
      const receipts = old.receipts.filter((entry) => entry.status !== 'completed' || entry.createdAt > now - 30 * 86_400_000);
      const duplicate = receipts.find((entry) => entry.key === input.key || entry.runId === input.runId);
      if (duplicate) return { kind: 'duplicate', runId: duplicate.runId, status: duplicate.status };
      if (receipts.length >= 20_000) return { kind: 'capacity' };
      const daily = old.days.find((entry) => entry.day === day) ?? emptyDay(day);
      if (old.days.some((entry) => entry.day > day)) throw new Error('企业招聘账本时间不一致，未调用模型');
      if (daily.requests >= budget.dailyRequests || daily.reservedTokens + input.reservedTokens > budget.dailyReservedTokens) return { kind: 'budget' };
      const state: LedgerState = { revision: old.revision + 1,
        days: [{ ...daily, requests: daily.requests + 1, reservedTokens: daily.reservedTokens + input.reservedTokens, unknownRequests: daily.unknownRequests + 1 },
          ...old.days.filter((entry) => entry.day !== day && entry.day >= dayAt(now - 7 * 86_400_000))],
        receipts: [...receipts, { key: input.key, runId: input.runId, status: 'reserved', day, createdAt: now }] };
      if (await this.store.compareAndSet(org, old.revision, state)) return { kind: 'reserved' };
    }
    throw new Error('企业招聘额度并发繁忙，未取得调用许可');
  }
  async finish(org: string, runId: string, status: 'completed' | 'unknown', counts?: { inputTokens: number | null; outputTokens: number | null }): Promise<void> {
    const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 20_000_000 ? value : null;
    const inputTokens = count(counts?.inputTokens); const outputTokens = count(counts?.outputTokens);
    for (let retry = 0; retry < 40; retry++) {
      const old = await this.store.get(org); const receipt = old?.receipts.find((entry) => entry.runId === runId);
      if (!old || !receipt) throw new Error('企业招聘调用记录缺失，请人工核对用量');
      if (receipt.status !== 'reserved') return;
      const next: LedgerState = { ...old, revision: old.revision + 1,
        receipts: old.receipts.map((entry) => entry.runId === runId ? { ...entry, status } : entry),
        days: old.days.map((entry) => entry.day === receipt.day ? { ...entry, inputTokens: entry.inputTokens + (inputTokens ?? 0), outputTokens: entry.outputTokens + (outputTokens ?? 0),
          unknownRequests: entry.unknownRequests - (inputTokens !== null && outputTokens !== null ? 1 : 0) } : entry) };
      if (await this.store.compareAndSet(org, old.revision, next)) return;
    }
    throw new Error('企业招聘用量回报未确认；预留额度保留，不会自动重试模型');
  }
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS enterprise_recruitment_usage_v1 (
  organization_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL
);`;
function codec(cipher: EncryptedFieldCipher) {
  return {
    encode: (org: string, state: LedgerState): string => JSON.stringify(cipher.encryptText(JSON.stringify(state), `recruitment-usage-v1:${org}`)),
    decode: (org: string, row?: Record<string, unknown>): LedgerState | null => row ? JSON.parse(cipher.decryptText(JSON.parse(String(row.payload)) as EncryptedFieldValue, `recruitment-usage-v1:${org}`)) as LedgerState : null,
  };
}
export function createSqliteRecruitmentUsageStore(db: () => Database, cipher: EncryptedFieldCipher): RecruitmentUsageStore {
  const c = codec(cipher); const ready = (): Database => { const database = db(); database.exec(SCHEMA); return database; };
  return {
    async get(org) { return c.decode(org, ready().prepare('SELECT payload FROM enterprise_recruitment_usage_v1 WHERE organization_id=?').get(org) as Record<string, unknown> | undefined); },
    async compareAndSet(org, expected, state) {
      const payload = c.encode(org, state);
      const result = expected === 0
        ? ready().prepare('INSERT INTO enterprise_recruitment_usage_v1(organization_id,revision,payload) VALUES(?,?,?) ON CONFLICT(organization_id) DO NOTHING').run(org, state.revision, payload)
        : ready().prepare('UPDATE enterprise_recruitment_usage_v1 SET revision=?,payload=? WHERE organization_id=? AND revision=?').run(state.revision, payload, org, expected);
      return Number(result.changes) === 1;
    },
  };
}
export function createPostgresRecruitmentUsageStore(pool: PostgresPoolLike, cipher: EncryptedFieldCipher): RecruitmentUsageStore {
  const c = codec(cipher); let init: Promise<unknown> | undefined;
  const ready = (): Promise<unknown> => init ??= pool.query(SCHEMA).catch((error) => { init = undefined; throw error; });
  return {
    async get(org) { await ready(); return c.decode(org, (await pool.query('SELECT payload FROM enterprise_recruitment_usage_v1 WHERE organization_id=$1', [org])).rows[0]); },
    async compareAndSet(org, expected, state) {
      await ready(); const values = [org, state.revision, c.encode(org, state), expected];
      const result = expected === 0
        ? await pool.query('INSERT INTO enterprise_recruitment_usage_v1(organization_id,revision,payload) VALUES($1,$2,$3) ON CONFLICT(organization_id) DO NOTHING', values.slice(0, 3))
        : await pool.query('UPDATE enterprise_recruitment_usage_v1 SET revision=$2,payload=$3 WHERE organization_id=$1 AND revision=$4', values);
      return result.rowCount === 1;
    },
  };
}
