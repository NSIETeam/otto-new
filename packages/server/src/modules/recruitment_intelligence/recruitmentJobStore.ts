/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { Database, EncryptedFieldCipher, EncryptedFieldValue } from '../data_platform/index.js';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';
import type { RecruitmentJobHeader, RecruitmentSharedJob } from './recruitmentJobs.js';

export interface RecruitmentJobStore {
  /** Worker-only cross-tenant index scan. No candidate payload is returned. */
  scan?(after: { organizationId: string; jobId: string }, limit: number): Promise<{ jobs: Array<{ organizationId: string; job: RecruitmentJobHeader; inboxExpiry?: string }>; hasMore: boolean }>;
  get(org: string, id: string): Promise<RecruitmentSharedJob | null>;
  list(org: string, after: string, pageSize?: number): Promise<{ jobs: RecruitmentJobHeader[]; nextCursor: string | null }>;
  compareAndSet(org: string, expectedRevision: number, job: RecruitmentSharedJob, dependencies?: Array<{ id: string; revision: number }>): Promise<boolean>;
  remove(org: string, id: string, expectedRevision: number): Promise<boolean>;
}
const SCHEMA = `CREATE TABLE IF NOT EXISTS enterprise_recruitment_jobs_v1 (
  organization_id TEXT NOT NULL, job_id TEXT NOT NULL, revision INTEGER NOT NULL,
  header TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(organization_id, job_id)
);`;
interface Row extends Record<string, unknown> { organization_id: string; job_id: string; header: string; payload: string }
function codec(cipher: EncryptedFieldCipher) {
  const encode = (org: string, id: string, part: string, data: unknown): string => JSON.stringify(cipher.encryptText(JSON.stringify(data), `recruitment-job-v1:${org}:${id}:${part}`));
  const decode = <T>(org: string, id: string, part: string, value: string): T => JSON.parse(cipher.decryptText(JSON.parse(value) as EncryptedFieldValue, `recruitment-job-v1:${org}:${id}:${part}`)) as T;
  return {
    values(org: string, job: RecruitmentSharedJob) {
      const { candidates, incomingMaterials, ...header } = job;
      const inboxExpiry = incomingMaterials?.length ? incomingMaterials.map((item) => item.expiresAt).sort()[0] : undefined;
      return [org, job.id, job.revision, encode(org, job.id, 'header', { ...header, ...(inboxExpiry ? { inboxExpiry } : {}) }), encode(org, job.id, 'candidates', incomingMaterials ? { candidates, incomingMaterials } : candidates)];
    },
    job(org: string, row?: Row): RecruitmentSharedJob | null {
      if (!row) return null;
      const { inboxExpiry: _expiry, ...header } = decode<RecruitmentJobHeader & { inboxExpiry?: string }>(org, row.job_id, 'header', row.header);
      const payload = decode<RecruitmentSharedJob['candidates'] | Pick<RecruitmentSharedJob, 'candidates' | 'incomingMaterials'>>(org, row.job_id, 'candidates', row.payload);
      return { ...header, ...(Array.isArray(payload) ? { candidates: payload } : payload) };
    },
    page(org: string, rows: Row[], limit = 100) {
      return { jobs: rows.slice(0, limit).map((row) => {
        const { inboxExpiry: _expiry, ...header } = decode<RecruitmentJobHeader & { inboxExpiry?: string }>(org, row.job_id, 'header', row.header);
        return header;
      }), nextCursor: rows.length > limit ? rows[limit - 1]!.job_id : null };
    },
    scan(rows: Row[], limit: number) {
      return { jobs: rows.slice(0, limit).map((row) => {
        const { inboxExpiry, ...job } = decode<RecruitmentJobHeader & { inboxExpiry?: string }>(row.organization_id, row.job_id, 'header', row.header);
        return { organizationId: row.organization_id, job, inboxExpiry };
      }), hasMore: rows.length > limit };
    },
  };
}
export function createSqliteRecruitmentJobStore(db: () => Database, cipher: EncryptedFieldCipher): RecruitmentJobStore {
  const c = codec(cipher);
  const ready = (): Database => { const database = db(); database.exec(SCHEMA); return database; };
  return {
    async scan(after, size) { const limit = Math.max(1, Math.min(100, Math.trunc(size))); return c.scan(ready().prepare('SELECT organization_id,job_id,header FROM enterprise_recruitment_jobs_v1 WHERE revision>0 AND (organization_id>? OR (organization_id=? AND job_id>?)) ORDER BY organization_id,job_id LIMIT ?').all(after.organizationId, after.organizationId, after.jobId, limit + 1) as Row[], limit); },
    async get(org, id) { return c.job(org, ready().prepare('SELECT job_id,header,payload FROM enterprise_recruitment_jobs_v1 WHERE organization_id=? AND job_id=? AND revision>0').get(org, id) as Row | undefined); },
    async list(org, after, size = 100) { const limit = Math.max(1, Math.min(100, Math.trunc(size))); return c.page(org, ready().prepare('SELECT job_id,header FROM enterprise_recruitment_jobs_v1 WHERE organization_id=? AND job_id>? AND revision>0 ORDER BY job_id LIMIT ?').all(org, after, limit + 1) as Row[], limit); },
    async compareAndSet(org, expected, job, dependencies = []) {
      if (expected === 0 && dependencies.length) return false;
      const values = c.values(org, job);
      const conditions = dependencies.map(() => ' AND EXISTS (SELECT 1 FROM enterprise_recruitment_jobs_v1 source WHERE source.organization_id=? AND source.job_id=? AND source.revision=? AND source.revision>0)').join('');
      const result = expected === 0
        ? ready().prepare('INSERT INTO enterprise_recruitment_jobs_v1(organization_id,job_id,revision,header,payload) VALUES(?,?,?,?,?) ON CONFLICT(organization_id,job_id) DO NOTHING').run(...values)
        : ready().prepare(`UPDATE enterprise_recruitment_jobs_v1 SET revision=?,header=?,payload=? WHERE organization_id=? AND job_id=? AND revision=?${conditions}`).run(values[2], values[3], values[4], org, job.id, expected, ...dependencies.flatMap((dependency) => [org, dependency.id, dependency.revision]));
      return Number(result.changes) === 1;
    },
    // Keep only a tombstone so a delayed create cannot resurrect a deleted archive.
    async remove(org, id, revision) { return Number(ready().prepare("UPDATE enterprise_recruitment_jobs_v1 SET revision=-1,header='',payload='' WHERE organization_id=? AND job_id=? AND revision=?").run(org, id, revision).changes) === 1; },
  };
}
export function createPostgresRecruitmentJobStore(pool: PostgresPoolLike, cipher: EncryptedFieldCipher): RecruitmentJobStore {
  const c = codec(cipher);
  let initialization: Promise<unknown> | undefined;
  const ready = (): Promise<unknown> => initialization ??= pool.query(SCHEMA).catch((error) => { initialization = undefined; throw error; });
  return {
    async scan(after, size) { await ready(); const limit = Math.max(1, Math.min(100, Math.trunc(size))); return c.scan((await pool.query<Row>('SELECT organization_id,job_id,header FROM enterprise_recruitment_jobs_v1 WHERE revision>0 AND (organization_id>$1 OR (organization_id=$1 AND job_id>$2)) ORDER BY organization_id,job_id LIMIT $3', [after.organizationId, after.jobId, limit + 1])).rows, limit); },
    async get(org, id) { await ready(); return c.job(org, (await pool.query<Row>('SELECT job_id,header,payload FROM enterprise_recruitment_jobs_v1 WHERE organization_id=$1 AND job_id=$2 AND revision>0', [org, id])).rows[0]); },
    async list(org, after, size = 100) { await ready(); const limit = Math.max(1, Math.min(100, Math.trunc(size))); return c.page(org, (await pool.query<Row>('SELECT job_id,header FROM enterprise_recruitment_jobs_v1 WHERE organization_id=$1 AND job_id>$2 AND revision>0 ORDER BY job_id LIMIT $3', [org, after, limit + 1])).rows, limit); },
    async compareAndSet(org, expected, job, dependencies = []) {
      if (expected === 0 && dependencies.length) return false;
      await ready();
      const values = c.values(org, job);
      const conditions = dependencies.map((_, index) => ` AND EXISTS (SELECT 1 FROM enterprise_recruitment_jobs_v1 source WHERE source.organization_id=$1 AND source.job_id=$${7 + index * 2} AND source.revision=$${8 + index * 2} AND source.revision>0)`).join('');
      const result = expected === 0
        ? await pool.query('INSERT INTO enterprise_recruitment_jobs_v1(organization_id,job_id,revision,header,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,job_id) DO NOTHING', values)
        : await pool.query(`UPDATE enterprise_recruitment_jobs_v1 SET revision=$3,header=$4,payload=$5 WHERE organization_id=$1 AND job_id=$2 AND revision=$6${conditions}`, [...values, expected, ...dependencies.flatMap((dependency) => [dependency.id, dependency.revision])]);
      return result.rowCount === 1;
    },
    async remove(org, id, revision) { await ready(); return (await pool.query("UPDATE enterprise_recruitment_jobs_v1 SET revision=-1,header='',payload='' WHERE organization_id=$1 AND job_id=$2 AND revision=$3", [org, id, revision])).rowCount === 1; },
  };
}
