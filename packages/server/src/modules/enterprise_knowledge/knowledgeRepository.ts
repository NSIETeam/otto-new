/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Database } from '../data_platform/index.js';
import { enterpriseKnowledgeContradictoryEvidenceIndexes } from './knowledgeRetentionPolicy.js';

export const ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH = 120;
export const ENTERPRISE_KNOWLEDGE_MAX_CATEGORY_LENGTH = 120;
export const ENTERPRISE_KNOWLEDGE_MAX_TITLE_LENGTH = 200;
export const ENTERPRISE_KNOWLEDGE_MAX_CONTENT_LENGTH = 200_000;
export const ENTERPRISE_KNOWLEDGE_MAX_CONTRIBUTOR_LENGTH = 160;
export const ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH = 200;
export const ENTERPRISE_KNOWLEDGE_MAX_SOURCE_LABEL_LENGTH = 300;
export const ENTERPRISE_KNOWLEDGE_MAX_QUERY_LENGTH = 500;

export type EnterpriseKnowledgeStatus = 'pending_review' | 'active' | 'archived';
export type EnterpriseKnowledgeSourceType =
  | 'manual'
  | 'auto_capture'
  | 'work_result'
  | 'task_log'
  | 'document'
  | 'offboarding';

export interface EnterpriseKnowledgeEntryView {
  id: number;
  organization_id: string;
  source_id: string | null;
  title: string;
  department: string | null;
  category: string;
  content: string;
  contributor: string | null;
  contributor_account_id: string | null;
  confidence: number;
  source_type: EnterpriseKnowledgeSourceType;
  source_label: string | null;
  status: EnterpriseKnowledgeStatus;
  version: number;
  content_hash: string | null;
  supersedes_id: number | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_due_at: string | null;
  expires_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  evidence_count?: number;
  distinct_session_count?: number;
  distinct_contributor_count?: number;
  verified_evidence_count?: number;
  first_observed_at?: string | null;
  last_observed_at?: string | null;
}

export interface EnterpriseKnowledgeRevisionView {
  id: number;
  knowledge_id: number;
  organization_id: string;
  version: number;
  title: string;
  department: string | null;
  category: string;
  content: string;
  contributor: string | null;
  confidence: number;
  source_type: EnterpriseKnowledgeSourceType;
  source_label: string | null;
  status: EnterpriseKnowledgeStatus;
  content_hash: string | null;
  changed_by: string | null;
  change_note: string | null;
  created_at: string;
  adjudication?: EnterpriseKnowledgeAdjudicationView;
}

export interface EnterpriseKnowledgeAdjudicationInput {
  acceptedEvidenceIds: number[];
  rejectedEvidenceIds: number[];
  rationale: string;
}

export interface EnterpriseKnowledgeAdjudicationView {
  id: number;
  knowledgeId: number;
  revisionVersion: number;
  acceptedEvidenceIds: number[];
  rejectedEvidenceIds: number[];
  rationale: string;
  adjudicatedBy: string;
  createdAt: string;
}

export interface EnterpriseKnowledgeRepositoryStore {
  db(): Database;
  defaultOrganizationId: string;
  organizationExists(organizationId: string): boolean;
}

export interface AddEnterpriseKnowledgeInput {
  department?: string;
  title?: string;
  category: string;
  content: string;
  contributor?: string;
  contributorAccountId?: string;
  confidence?: number;
  organizationId?: string;
  sourceId?: string;
  sourceType?: EnterpriseKnowledgeSourceType;
  sourceLabel?: string;
  status?: EnterpriseKnowledgeStatus;
  reviewedBy?: string;
}

export interface SaveEnterpriseKnowledgeResult {
  outcome: 'added' | 'updated' | 'unchanged';
  entry: EnterpriseKnowledgeEntryView;
}

export interface ReviseEnterpriseKnowledgeInput {
  id: number;
  organizationId?: string;
  title?: string;
  category?: string;
  content?: string;
  confidence?: number;
  sourceLabel?: string | null;
  changedBy: string;
  changeNote?: string;
  /** 管理员已检查冲突证据，并以本次人工修订作为裁决结论。 */
  resolveConflict?: boolean;
  adjudication?: EnterpriseKnowledgeAdjudicationInput;
}

export interface RefreshEnterpriseKnowledgeEvidenceInput {
  id: number;
  organizationId?: string;
  confidence: number;
  sourceLabel: string;
  changedBy: string;
  changeNote: string;
}

export interface RevalidateEnterpriseKnowledgeInput {
  id: number;
  organizationId?: string;
  reviewer: string;
  rationale: string;
  validForDays: number;
}

function requireOrganization(store: EnterpriseKnowledgeRepositoryStore, value?: string): string {
  const organizationId = value?.trim() || store.defaultOrganizationId;
  if (!organizationId || !store.organizationExists(organizationId)) {
    throw new Error('Organization not found');
  }
  return organizationId;
}

function normalizeRequiredText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maximum) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  maximum: number,
  field: string,
): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`${field} is invalid`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeConfidence(value: number | undefined): number {
  if (value === undefined) return 0.5;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('knowledge confidence must be between 0 and 1');
  }
  return value;
}

function normalizeStatus(value: unknown): EnterpriseKnowledgeStatus {
  if (value === undefined) return 'active';
  if (value === 'pending_review' || value === 'active' || value === 'archived') return value;
  throw new Error('knowledge status is invalid');
}

function normalizeAdjudicationEvidenceIds(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${field} is invalid`);
  }
  const normalized = [...new Set(value)];
  if (!normalized.every((id) => Number.isSafeInteger(id) && Number(id) > 0)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized as number[];
}

function parseAdjudicationEvidenceIds(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0)
      : [];
  } catch {
    return [];
  }
}

function normalizeSourceType(value: unknown): EnterpriseKnowledgeSourceType {
  if (value === undefined) return 'manual';
  if (
    value === 'manual' || value === 'auto_capture' || value === 'work_result'
    || value === 'task_log' || value === 'document' || value === 'offboarding'
  ) return value;
  throw new Error('knowledge source type is invalid');
}

function deriveTitle(content: string, category: string): string {
  const firstLine = content
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[#>*-]+\s*/u, '').trim())
    .find(Boolean);
  return (firstLine || category).slice(0, ENTERPRISE_KNOWLEDGE_MAX_TITLE_LENGTH);
}

function knowledgeHash(input: {
  title: string;
  department: string | null;
  category: string;
  content: string;
}): string {
  return createHash('sha256')
    .update([input.title, input.department ?? '', input.category, input.content].join('\0'))
    .digest('hex');
}

function runTransaction<T>(database: Database, operation: () => T): T {
  const ownsTransaction = !database.inTransaction;
  if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (ownsTransaction) database.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction && database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function lifecycleDays(sourceType: EnterpriseKnowledgeSourceType): {
  reviewDays: number;
  validDays: number;
} {
  return sourceType === 'auto_capture'
    ? { reviewDays: 90, validDays: 180 }
    : { reviewDays: 180, validDays: 365 };
}

function refreshKnowledgeLifecycle(
  database: Database,
  id: number,
  organizationId: string,
  sourceType: EnterpriseKnowledgeSourceType,
  validForDays?: number,
  referenceAt?: string | null,
): void {
  const defaults = lifecycleDays(sourceType);
  const validDays = validForDays ?? defaults.validDays;
  const reviewDays = validForDays === undefined
    ? defaults.reviewDays
    : Math.max(15, Math.floor(validDays / 2));
  database.prepare(
    `UPDATE knowledge SET
       review_due_at = CASE WHEN status = 'active' THEN datetime(COALESCE(?, 'now'), ?) ELSE NULL END,
       expires_at = CASE WHEN status = 'active' THEN datetime(COALESCE(?, 'now'), ?) ELSE NULL END
     WHERE id = ? AND organization_id = ?`,
  ).run(
    referenceAt ?? null,
    `+${reviewDays} days`,
    referenceAt ?? null,
    `+${validDays} days`,
    id,
    organizationId,
  );
}

function latestKnowledgeEvidenceObservedAt(
  database: Database,
  id: number,
  organizationId: string,
): string | null {
  const row = database.prepare(
    `SELECT MAX(observed_at) AS observed_at FROM knowledge_retention_evidence
     WHERE promoted_knowledge_id = ? AND organization_id = ?`,
  ).get(id, organizationId) as { observed_at: string | null };
  return row.observed_at;
}

function getEntry(
  database: Database,
  id: number,
  organizationId: string,
): EnterpriseKnowledgeEntryView | null {
  return (database
    .prepare('SELECT * FROM knowledge WHERE id = ? AND organization_id = ?')
    .get(id, organizationId) as EnterpriseKnowledgeEntryView | undefined) ?? null;
}

function writeRevision(
  database: Database,
  entry: EnterpriseKnowledgeEntryView,
  changedBy: string | null,
  changeNote: string | null,
): void {
  database.prepare(
    `INSERT OR IGNORE INTO knowledge_revisions
     (knowledge_id, organization_id, version, title, department, category, content,
      contributor, confidence, source_type, source_label, status, content_hash,
      changed_by, change_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.organization_id,
    entry.version,
    entry.title,
    entry.department,
    entry.category,
    entry.content,
    entry.contributor,
    entry.confidence,
    entry.source_type,
    entry.source_label,
    entry.status,
    entry.content_hash,
    changedBy,
    changeNote,
  );
}

export function saveEnterpriseKnowledgeInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  input: AddEnterpriseKnowledgeInput,
): SaveEnterpriseKnowledgeResult {
  const organizationId = requireOrganization(store, input.organizationId);
  const department = normalizeOptionalText(
    input.department,
    ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH,
    'knowledge department',
  );
  const category = normalizeRequiredText(
    input.category,
    ENTERPRISE_KNOWLEDGE_MAX_CATEGORY_LENGTH,
    'knowledge category',
  );
  const content = normalizeRequiredText(
    input.content,
    ENTERPRISE_KNOWLEDGE_MAX_CONTENT_LENGTH,
    'knowledge content',
  );
  const title = normalizeOptionalText(
    input.title,
    ENTERPRISE_KNOWLEDGE_MAX_TITLE_LENGTH,
    'knowledge title',
  ) ?? deriveTitle(content, category);
  const contributor = normalizeOptionalText(
    input.contributor,
    ENTERPRISE_KNOWLEDGE_MAX_CONTRIBUTOR_LENGTH,
    'knowledge contributor',
  );
  const contributorAccountId = normalizeOptionalText(
    input.contributorAccountId,
    200,
    'knowledge contributor account id',
  );
  const sourceId = normalizeOptionalText(
    input.sourceId,
    ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH,
    'knowledge source id',
  );
  const sourceType = normalizeSourceType(input.sourceType);
  const sourceLabel = normalizeOptionalText(
    input.sourceLabel,
    ENTERPRISE_KNOWLEDGE_MAX_SOURCE_LABEL_LENGTH,
    'knowledge source label',
  );
  const status = normalizeStatus(input.status);
  const confidence = normalizeConfidence(input.confidence);
  const contentHash = knowledgeHash({ title, department, category, content });
  const reviewedBy = normalizeOptionalText(
    input.reviewedBy,
    ENTERPRISE_KNOWLEDGE_MAX_CONTRIBUTOR_LENGTH,
    'knowledge reviewer',
  );
  const database = store.db();

  return runTransaction(database, () => {
    const existing = sourceId
      ? database.prepare(
          `SELECT * FROM knowledge
           WHERE organization_id = ? AND source_id = ? AND status <> 'archived'
           ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC LIMIT 1`,
        ).get(organizationId, sourceId) as EnterpriseKnowledgeEntryView | undefined
      : undefined;

    if (existing?.content_hash === contentHash && existing.status === status) {
      return { outcome: 'unchanged', entry: existing };
    }

    if (existing && (existing.status === 'pending_review' || status === 'active')) {
      database.prepare(
        `UPDATE knowledge SET
           title = ?, department = ?, category = ?, content = ?, contributor = ?,
           contributor_account_id = ?, confidence = ?, source_type = ?, source_label = ?,
           status = ?, version = version + 1, content_hash = ?, reviewed_by = ?,
           reviewed_at = CASE WHEN ? = 'active' THEN datetime('now') ELSE NULL END,
           archived_at = CASE WHEN ? = 'archived' THEN datetime('now') ELSE NULL END,
           updated_at = datetime('now')
         WHERE id = ? AND organization_id = ?`,
      ).run(
        title,
        department,
        category,
        content,
        contributor,
        contributorAccountId,
        confidence,
        sourceType,
        sourceLabel,
        status,
        contentHash,
        reviewedBy,
        status,
        status,
        existing.id,
        organizationId,
      );
      refreshKnowledgeLifecycle(database, existing.id, organizationId, sourceType);
      const updated = getEntry(database, existing.id, organizationId)!;
      writeRevision(database, updated, reviewedBy ?? contributor, 'knowledge updated');
      return { outcome: 'updated', entry: updated };
    }

    let effectiveSourceId = sourceId;
    let supersedesId: number | null = null;
    if (existing && status === 'pending_review') {
      effectiveSourceId = `${sourceId}:revision:${contentHash.slice(0, 12)}`
        .slice(0, ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH);
      supersedesId = existing.id;
      const duplicateRevision = database.prepare(
        `SELECT * FROM knowledge
         WHERE organization_id = ? AND source_id = ? AND status <> 'archived' LIMIT 1`,
      ).get(organizationId, effectiveSourceId) as EnterpriseKnowledgeEntryView | undefined;
      if (duplicateRevision) {
        return { outcome: 'unchanged', entry: duplicateRevision };
      }
    } else if (!existing && sourceId && status === 'pending_review') {
      const archivedPredecessor = database.prepare(
        `SELECT * FROM knowledge
         WHERE organization_id = ? AND source_id = ? AND status = 'archived'
         ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1`,
      ).get(organizationId, sourceId) as EnterpriseKnowledgeEntryView | undefined;
      supersedesId = archivedPredecessor?.id ?? null;
    }

    const result = database.prepare(
      `INSERT INTO knowledge
       (organization_id, source_id, title, department, category, content,
        contributor, contributor_account_id, confidence, source_type, source_label,
        status, version, content_hash, supersedes_id, reviewed_by, reviewed_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?,
         CASE WHEN ? = 'active' THEN datetime('now') ELSE NULL END,
         CASE WHEN ? = 'archived' THEN datetime('now') ELSE NULL END)`,
    ).run(
      organizationId,
      effectiveSourceId,
      title,
      department,
      category,
      content,
      contributor,
      contributorAccountId,
      confidence,
      sourceType,
      sourceLabel,
      status,
      contentHash,
      supersedesId,
      reviewedBy,
      status,
      status,
    ) as { lastInsertRowid?: number | bigint };
    const id = Number(result.lastInsertRowid);
    refreshKnowledgeLifecycle(database, id, organizationId, sourceType);
    const entry = getEntry(database, id, organizationId);
    if (!entry) throw new Error('knowledge insert failed');
    writeRevision(database, entry, reviewedBy ?? contributor, 'knowledge created');
    return { outcome: 'added', entry };
  });
}

/** Compatibility wrapper for trusted internal callers. */
export function addEnterpriseKnowledgeInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  input: AddEnterpriseKnowledgeInput,
): boolean {
  return saveEnterpriseKnowledgeInRepository(store, { ...input, status: input.status ?? 'active' })
    .outcome === 'added';
}

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

const KNOWLEDGE_WITH_EVIDENCE_SELECT = `SELECT k.*,
  COALESCE((SELECT COUNT(*) FROM knowledge_retention_evidence e
    WHERE e.organization_id = k.organization_id AND e.promoted_knowledge_id = k.id), 0)
    AS evidence_count,
  COALESCE((SELECT COUNT(DISTINCT e.source_session_id)
    FROM knowledge_retention_evidence e
    WHERE e.organization_id = k.organization_id AND e.promoted_knowledge_id = k.id), 0)
    AS distinct_session_count,
  COALESCE((SELECT COUNT(DISTINCT e.contributor_account_id)
    FROM knowledge_retention_evidence e
    WHERE e.organization_id = k.organization_id AND e.promoted_knowledge_id = k.id), 0)
    AS distinct_contributor_count,
  COALESCE((SELECT SUM(e.verified)
    FROM knowledge_retention_evidence e
    WHERE e.organization_id = k.organization_id AND e.promoted_knowledge_id = k.id), 0)
    AS verified_evidence_count,
  (SELECT MIN(e.observed_at) FROM knowledge_retention_evidence e
    WHERE e.organization_id = k.organization_id AND e.promoted_knowledge_id = k.id)
    AS first_observed_at,
  (SELECT MAX(e.observed_at) FROM knowledge_retention_evidence e
    WHERE e.organization_id = k.organization_id AND e.promoted_knowledge_id = k.id)
    AS last_observed_at
  FROM knowledge k`;

function getEntryWithEvidence(
  database: Database,
  id: number,
  organizationId: string,
): EnterpriseKnowledgeEntryView | null {
  return (database.prepare(
    `${KNOWLEDGE_WITH_EVIDENCE_SELECT}
     WHERE k.id = ? AND k.organization_id = ?`,
  ).get(id, organizationId) as EnterpriseKnowledgeEntryView | undefined) ?? null;
}

/**
 * Refreshes evidence-derived metadata without pretending that an administrator
 * re-reviewed the published conclusion. The revision trail still records why
 * the reliability changed.
 */
export function refreshEnterpriseKnowledgeEvidenceInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  input: RefreshEnterpriseKnowledgeEvidenceInput,
): EnterpriseKnowledgeEntryView | null {
  const organizationId = requireOrganization(store, input.organizationId);
  const confidence = normalizeConfidence(input.confidence);
  const sourceLabel = normalizeRequiredText(
    input.sourceLabel,
    ENTERPRISE_KNOWLEDGE_MAX_SOURCE_LABEL_LENGTH,
    'knowledge source label',
  );
  const changedBy = normalizeRequiredText(
    input.changedBy,
    ENTERPRISE_KNOWLEDGE_MAX_CONTRIBUTOR_LENGTH,
    'knowledge editor',
  );
  const changeNote = normalizeRequiredText(input.changeNote, 500, 'knowledge change note');
  const database = store.db();
  return runTransaction(database, () => {
    const current = getEntry(database, input.id, organizationId);
    if (!current) return null;
    if (current.status === 'archived') {
      throw new Error('archived knowledge evidence cannot be refreshed');
    }
    if (current.confidence === confidence && current.source_label === sourceLabel) {
      if (current.status === 'active') {
        refreshKnowledgeLifecycle(
          database,
          current.id,
          organizationId,
          current.source_type,
          undefined,
          latestKnowledgeEvidenceObservedAt(database, current.id, organizationId),
        );
      }
      return getEntryWithEvidence(database, current.id, organizationId);
    }
    database.prepare(
      `UPDATE knowledge SET confidence = ?, source_label = ?, version = version + 1,
       updated_at = datetime('now') WHERE id = ? AND organization_id = ?`,
    ).run(confidence, sourceLabel, current.id, organizationId);
    if (current.status === 'active') {
      refreshKnowledgeLifecycle(
        database,
        current.id,
        organizationId,
        current.source_type,
        undefined,
        latestKnowledgeEvidenceObservedAt(database, current.id, organizationId),
      );
    }
    const updated = getEntry(database, current.id, organizationId)!;
    writeRevision(database, updated, changedBy, changeNote);
    return getEntryWithEvidence(database, current.id, organizationId);
  });
}

function queryTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = new Set<string>([normalized]);
  for (const match of normalized.matchAll(/[\p{L}\p{N}_-]{2,}/gu)) {
    const token = match[0];
    terms.add(token);
    if (/\p{Script=Han}/u.test(token) && token.length > 3) {
      for (let index = 0; index < token.length - 1; index += 2) {
        terms.add(token.slice(index, index + 2));
      }
    }
  }
  return [...terms].sort((left, right) => right.length - left.length).slice(0, 12);
}

function knowledgeRelevance(entry: EnterpriseKnowledgeEntryView, terms: string[]): number {
  const title = entry.title.toLowerCase();
  const content = entry.content.toLowerCase();
  const metadata = `${entry.category} ${entry.source_label ?? ''}`.toLowerCase();
  let score = entry.confidence;
  score += Math.min(2.5, Math.log2(1 + (entry.evidence_count ?? 0)));
  score += Math.min(1.5, (entry.distinct_contributor_count ?? 0) * 0.5);
  score += Math.min(1, (entry.distinct_session_count ?? 0) * 0.2);
  if (entry.source_type === 'auto_capture') {
    const lastObserved = Date.parse(entry.last_observed_at || entry.updated_at);
    if (Number.isFinite(lastObserved)) {
      const ageDays = Math.max(0, (Date.now() - lastObserved) / 86_400_000);
      if (ageDays > 180) score -= 2;
      else if (ageDays > 90) score -= 0.5;
    }
  }
  for (const term of terms) {
    if (title.includes(term)) score += 8;
    if (metadata.includes(term)) score += 4;
    if (content.includes(term)) score += 2;
  }
  return score;
}

function searchRows(
  database: Database,
  baseSql: string,
  baseParams: Array<string | number>,
  query: string,
): EnterpriseKnowledgeEntryView[] {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return database.prepare(
      `${baseSql} ORDER BY evidence_count DESC, datetime(updated_at) DESC, id DESC LIMIT 100`,
    )
      .all(...baseParams) as EnterpriseKnowledgeEntryView[];
  }
  const matches = terms.map(() =>
    `(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
      OR category LIKE ? ESCAPE '\\' OR source_label LIKE ? ESCAPE '\\')`,
  ).join(' OR ');
  const params = [...baseParams];
  for (const term of terms) {
    const pattern = `%${escapeLikeLiteral(term)}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  const rows = database.prepare(`${baseSql} AND (${matches}) LIMIT 300`)
    .all(...params) as EnterpriseKnowledgeEntryView[];
  return rows
    .map((entry) => ({ entry, score: knowledgeRelevance(entry, terms) }))
    .sort((left, right) => right.score - left.score
      || right.entry.updated_at.localeCompare(left.entry.updated_at))
    .slice(0, 20)
    .map(({ entry }) => entry);
}

export function listEnterpriseKnowledgeFromRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  department?: string,
  category?: string,
  organizationId?: string,
): EnterpriseKnowledgeEntryView[] {
  const normalizedOrganizationId = requireOrganization(store, organizationId);
  const normalizedDepartment = normalizeOptionalText(
    department,
    ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH,
    'knowledge department',
  );
  const normalizedCategory = normalizeOptionalText(
    category,
    ENTERPRISE_KNOWLEDGE_MAX_CATEGORY_LENGTH,
    'knowledge category',
  );
  let sql = `${KNOWLEDGE_WITH_EVIDENCE_SELECT} WHERE k.organization_id = ? AND k.status = 'active'
    AND (k.expires_at IS NULL OR datetime(k.expires_at) > datetime('now'))`;
  const params: string[] = [normalizedOrganizationId];
  if (normalizedDepartment) {
    sql += ' AND k.department = ?';
    params.push(normalizedDepartment);
  }
  if (normalizedCategory) {
    sql += ' AND k.category = ?';
    params.push(normalizedCategory);
  }
  sql += ' ORDER BY evidence_count DESC, datetime(k.updated_at) DESC, k.id DESC';
  return store.db().prepare(sql).all(...params) as EnterpriseKnowledgeEntryView[];
}

export function searchEnterpriseKnowledgeInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  query: string,
  department?: string,
  organizationId?: string,
): EnterpriseKnowledgeEntryView[] {
  const normalizedOrganizationId = requireOrganization(store, organizationId);
  const normalizedDepartment = normalizeOptionalText(
    department,
    ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH,
    'knowledge department',
  );
  const normalizedQuery = normalizeOptionalText(
    query,
    ENTERPRISE_KNOWLEDGE_MAX_QUERY_LENGTH,
    'knowledge query',
  ) ?? '';
  let sql = `${KNOWLEDGE_WITH_EVIDENCE_SELECT} WHERE k.organization_id = ? AND k.status = 'active'
    AND (k.expires_at IS NULL OR datetime(k.expires_at) > datetime('now'))`;
  const params: Array<string | number> = [normalizedOrganizationId];
  if (normalizedDepartment) {
    sql += ' AND k.department = ?';
    params.push(normalizedDepartment);
  }
  return searchRows(store.db(), sql, params, normalizedQuery);
}

export function listMemberEnterpriseKnowledgeFromRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  memberDepartment: string | null | undefined,
  query = '',
  organizationId?: string,
  options: { includeOwnPending?: boolean; contributorAccountId?: string } = {},
): EnterpriseKnowledgeEntryView[] {
  const normalizedOrganizationId = requireOrganization(store, organizationId);
  const department = normalizeOptionalText(
    memberDepartment,
    ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH,
    'member department',
  );
  const normalizedQuery = normalizeOptionalText(
    query,
    ENTERPRISE_KNOWLEDGE_MAX_QUERY_LENGTH,
    'knowledge query',
  ) ?? '';
  const contributorAccountId = normalizeOptionalText(
    options.contributorAccountId,
    200,
    'knowledge contributor account id',
  );
  let sql = `${KNOWLEDGE_WITH_EVIDENCE_SELECT} WHERE k.organization_id = ?`;
  const params: Array<string | number> = [normalizedOrganizationId];
  if (options.includeOwnPending && contributorAccountId) {
    sql += ` AND ((k.status = 'active'
      AND (k.expires_at IS NULL OR datetime(k.expires_at) > datetime('now')))
      OR (k.status = 'pending_review' AND k.contributor_account_id = ?))`;
    params.push(contributorAccountId);
  } else {
    sql += ` AND k.status = 'active'
      AND (k.expires_at IS NULL OR datetime(k.expires_at) > datetime('now'))`;
  }
  if (department) {
    sql += ' AND (k.department IS NULL OR k.department = ?)';
    params.push(department);
  } else {
    sql += ' AND k.department IS NULL';
  }
  return searchRows(store.db(), sql, params, normalizedQuery);
}

export function listEnterpriseKnowledgeForAdministrationFromRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  query = '',
  department?: string,
  organizationId?: string,
  status?: EnterpriseKnowledgeStatus,
): EnterpriseKnowledgeEntryView[] {
  const normalizedOrganizationId = requireOrganization(store, organizationId);
  const normalizedDepartment = normalizeOptionalText(
    department,
    ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH,
    'knowledge department',
  );
  const normalizedQuery = normalizeOptionalText(
    query,
    ENTERPRISE_KNOWLEDGE_MAX_QUERY_LENGTH,
    'knowledge query',
  ) ?? '';
  let sql = `${KNOWLEDGE_WITH_EVIDENCE_SELECT} WHERE k.organization_id = ?`;
  const params: Array<string | number> = [normalizedOrganizationId];
  if (status) {
    sql += ' AND k.status = ?';
    params.push(normalizeStatus(status));
  }
  if (normalizedDepartment) {
    sql += ' AND k.department = ?';
    params.push(normalizedDepartment);
  }
  return searchRows(store.db(), sql, params, normalizedQuery);
}

export function listEnterpriseKnowledgeForBackupFromRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  organizationId?: string,
): EnterpriseKnowledgeEntryView[] {
  const normalizedOrganizationId = requireOrganization(store, organizationId);
  return store.db().prepare(
    `${KNOWLEDGE_WITH_EVIDENCE_SELECT}
     WHERE k.organization_id = ?
     ORDER BY datetime(k.updated_at) DESC, k.id DESC`,
  ).all(normalizedOrganizationId) as EnterpriseKnowledgeEntryView[];
}

export function reviewEnterpriseKnowledgeInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  input: {
    id: number;
    organizationId?: string;
    action: 'approve' | 'archive';
    reviewer: string;
    note?: string;
  },
): EnterpriseKnowledgeEntryView | null {
  const organizationId = requireOrganization(store, input.organizationId);
  const reviewer = normalizeRequiredText(
    input.reviewer,
    ENTERPRISE_KNOWLEDGE_MAX_CONTRIBUTOR_LENGTH,
    'knowledge reviewer',
  );
  const note = normalizeOptionalText(input.note, 500, 'knowledge review note');
  const database = store.db();
  return runTransaction(database, () => {
    const entry = getEntry(database, input.id, organizationId);
    if (!entry) return null;
    if (input.action === 'approve' && entry.status === 'active') return entry;
    if (input.action === 'approve' && entry.status !== 'pending_review') {
      throw new Error('only pending knowledge can be approved');
    }
    if (
      input.action === 'approve'
      && entry.source_label?.includes('证据存在冲突')
    ) {
      throw new Error('contested knowledge must be resolved before approval');
    }
    let canonicalSourceId = entry.source_id;
    if (input.action === 'approve' && entry.supersedes_id) {
      const superseded = getEntry(database, entry.supersedes_id, organizationId);
      if (superseded) {
        canonicalSourceId = superseded.source_id ?? canonicalSourceId;
        const activeCanonical = canonicalSourceId
          ? database.prepare(
              `SELECT * FROM knowledge
               WHERE organization_id = ? AND source_id = ? AND status = 'active'
               ORDER BY id DESC LIMIT 1`,
            ).get(organizationId, canonicalSourceId) as EnterpriseKnowledgeEntryView | undefined
          : undefined;
        if (activeCanonical && activeCanonical.id !== entry.id) {
          database.prepare(
            `UPDATE knowledge SET status = 'archived', archived_at = datetime('now'),
             version = version + 1, updated_at = datetime('now')
             WHERE id = ? AND organization_id = ?`,
          ).run(activeCanonical.id, organizationId);
          writeRevision(
            database,
            getEntry(database, activeCanonical.id, organizationId)!,
            reviewer,
            `superseded by knowledge ${entry.id}`,
          );
        }
      }
    }
    const nextStatus: EnterpriseKnowledgeStatus = input.action === 'approve' ? 'active' : 'archived';
    database.prepare(
      `UPDATE knowledge SET source_id = ?, status = ?, version = version + 1,
       reviewed_by = ?, reviewed_at = datetime('now'),
       archived_at = CASE WHEN ? = 'archived' THEN datetime('now') ELSE NULL END,
       updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
    ).run(
      canonicalSourceId,
      nextStatus,
      reviewer,
      nextStatus,
      entry.id,
      organizationId,
    );
    refreshKnowledgeLifecycle(database, entry.id, organizationId, entry.source_type);
    const updated = getEntry(database, entry.id, organizationId)!;
    writeRevision(database, updated, reviewer, note ?? input.action);
    return updated;
  });
}

export function reviseEnterpriseKnowledgeInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  input: ReviseEnterpriseKnowledgeInput,
): EnterpriseKnowledgeEntryView | null {
  const organizationId = requireOrganization(store, input.organizationId);
  const database = store.db();
  return runTransaction(database, () => {
    const current = getEntry(database, input.id, organizationId);
    if (!current) return null;
    if (current.status === 'archived') throw new Error('archived knowledge cannot be revised');
    const contested = Boolean(current.source_label?.includes('证据存在冲突'));
    if (input.resolveConflict === true && !contested) {
      throw new Error('knowledge is not contested');
    }
    if (input.adjudication && input.resolveConflict !== true) {
      throw new Error('adjudication requires conflict resolution');
    }
    let adjudication: EnterpriseKnowledgeAdjudicationInput | null = null;
    if (contested && input.resolveConflict === true) {
      if (!input.adjudication) {
        throw new Error('contested knowledge requires an evidence adjudication');
      }
      const acceptedEvidenceIds = normalizeAdjudicationEvidenceIds(
        input.adjudication.acceptedEvidenceIds,
        'accepted evidence ids',
      );
      const rejectedEvidenceIds = normalizeAdjudicationEvidenceIds(
        input.adjudication.rejectedEvidenceIds,
        'rejected evidence ids',
      );
      if (acceptedEvidenceIds.length === 0 || rejectedEvidenceIds.length === 0) {
        throw new Error('adjudication must accept and reject evidence');
      }
      if (acceptedEvidenceIds.some((id) => rejectedEvidenceIds.includes(id))) {
        throw new Error('adjudication evidence cannot be both accepted and rejected');
      }
      const rationale = normalizeRequiredText(
        input.adjudication.rationale,
        1_000,
        'adjudication rationale',
      );
      if (rationale.length < 12) throw new Error('adjudication rationale is too short');
      const evidence = database.prepare(
        `SELECT id, content FROM knowledge_retention_evidence
         WHERE organization_id = ? AND promoted_knowledge_id = ?
         ORDER BY datetime(observed_at), id`,
      ).all(organizationId, current.id) as Array<{ id: number; content: string }>;
      const evidenceIds = new Set(evidence.map((item) => item.id));
      const selectedIds = [...acceptedEvidenceIds, ...rejectedEvidenceIds];
      if (selectedIds.some((id) => !evidenceIds.has(id))) {
        throw new Error('adjudication evidence does not belong to this knowledge');
      }
      const contradictoryIndexes = enterpriseKnowledgeContradictoryEvidenceIndexes(
        evidence.map((item) => item.content),
      );
      const contradictoryEvidenceIds = [...contradictoryIndexes]
        .map((index) => evidence[index]?.id)
        .filter((id): id is number => id !== undefined);
      const selectedSet = new Set(selectedIds);
      if (contradictoryEvidenceIds.some((id) => !selectedSet.has(id))) {
        throw new Error('every contested evidence item must be adjudicated');
      }
      adjudication = { acceptedEvidenceIds, rejectedEvidenceIds, rationale };
    }
    const title = input.title === undefined
      ? current.title
      : normalizeRequiredText(input.title, ENTERPRISE_KNOWLEDGE_MAX_TITLE_LENGTH, 'knowledge title');
    const category = input.category === undefined
      ? current.category
      : normalizeRequiredText(input.category, ENTERPRISE_KNOWLEDGE_MAX_CATEGORY_LENGTH, 'knowledge category');
    const content = input.content === undefined
      ? current.content
      : normalizeRequiredText(input.content, ENTERPRISE_KNOWLEDGE_MAX_CONTENT_LENGTH, 'knowledge content');
    const confidence = input.confidence === undefined
      ? current.confidence
      : normalizeConfidence(input.confidence);
    const sourceLabel = input.resolveConflict === true
      && current.source_label?.includes('证据存在冲突')
      ? '管理员已裁决冲突；以本次人工修订结论为准'
      : input.sourceLabel === undefined
        ? current.source_label
        : normalizeOptionalText(
          input.sourceLabel,
          ENTERPRISE_KNOWLEDGE_MAX_SOURCE_LABEL_LENGTH,
          'knowledge source label',
        );
    const changedBy = normalizeRequiredText(
      input.changedBy,
      ENTERPRISE_KNOWLEDGE_MAX_CONTRIBUTOR_LENGTH,
      'knowledge editor',
    );
    const hash = knowledgeHash({ title, department: current.department, category, content });
    if (hash === current.content_hash && sourceLabel === current.source_label
      && confidence === current.confidence) return current;
    database.prepare(
      `UPDATE knowledge SET title = ?, category = ?, content = ?, confidence = ?,
       source_label = ?, content_hash = ?, version = version + 1,
       reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
    ).run(
      title,
      category,
      content,
      confidence,
      sourceLabel,
      hash,
      changedBy,
      current.id,
      organizationId,
    );
    if (current.status === 'active') {
      refreshKnowledgeLifecycle(database, current.id, organizationId, current.source_type);
    }
    const updated = getEntry(database, current.id, organizationId)!;
    writeRevision(
      database,
      updated,
      changedBy,
      normalizeOptionalText(input.changeNote, 500, 'knowledge change note') ?? 'knowledge revised',
    );
    if (adjudication) {
      database.prepare(
        `INSERT INTO knowledge_adjudications
         (knowledge_id, organization_id, revision_version,
          accepted_evidence_ids_json, rejected_evidence_ids_json,
          rationale, adjudicated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        updated.id,
        organizationId,
        updated.version,
        JSON.stringify(adjudication.acceptedEvidenceIds),
        JSON.stringify(adjudication.rejectedEvidenceIds),
        adjudication.rationale,
        changedBy,
      );
    }
    return updated;
  });
}

export function revalidateEnterpriseKnowledgeInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  input: RevalidateEnterpriseKnowledgeInput,
): EnterpriseKnowledgeEntryView | null {
  const organizationId = requireOrganization(store, input.organizationId);
  const reviewer = normalizeRequiredText(
    input.reviewer,
    ENTERPRISE_KNOWLEDGE_MAX_CONTRIBUTOR_LENGTH,
    'knowledge reviewer',
  );
  const rationale = normalizeRequiredText(
    input.rationale,
    1_000,
    'knowledge revalidation rationale',
  );
  if (rationale.length < 12) {
    throw new Error('knowledge revalidation rationale is too short');
  }
  if (!Number.isSafeInteger(input.validForDays)
    || input.validForDays < 30
    || input.validForDays > 365) {
    throw new Error('knowledge validity days must be between 30 and 365');
  }
  const database = store.db();
  return runTransaction(database, () => {
    const current = getEntry(database, input.id, organizationId);
    if (!current) return null;
    if (current.status !== 'active') {
      throw new Error('only active knowledge can be revalidated');
    }
    if (current.source_label?.includes('证据存在冲突')) {
      throw new Error('contested knowledge cannot be revalidated');
    }
    database.prepare(
      `UPDATE knowledge SET version = version + 1, reviewed_by = ?,
       reviewed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
    ).run(reviewer, current.id, organizationId);
    refreshKnowledgeLifecycle(
      database,
      current.id,
      organizationId,
      current.source_type,
      input.validForDays,
    );
    const updated = getEntry(database, current.id, organizationId)!;
    writeRevision(database, updated, reviewer, `复核确认：${rationale}`);
    database.prepare(
      `INSERT INTO knowledge_revalidations
       (knowledge_id, organization_id, revision_version, rationale,
        valid_for_days, review_due_at, expires_at, reviewed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      updated.id,
      organizationId,
      updated.version,
      rationale,
      input.validForDays,
      updated.review_due_at,
      updated.expires_at,
      reviewer,
    );
    return getEntryWithEvidence(database, updated.id, organizationId);
  });
}

export function listEnterpriseKnowledgeRevisionsFromRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  id: number,
  organizationId?: string,
): EnterpriseKnowledgeRevisionView[] {
  const normalizedOrganizationId = requireOrganization(store, organizationId);
  const database = store.db();
  const revisions = database.prepare(
    `SELECT * FROM knowledge_revisions
     WHERE organization_id = ? AND knowledge_id = ?
     ORDER BY version DESC, id DESC`,
  ).all(normalizedOrganizationId, id) as EnterpriseKnowledgeRevisionView[];
  const adjudications = database.prepare(
    `SELECT * FROM knowledge_adjudications
     WHERE organization_id = ? AND knowledge_id = ?
     ORDER BY revision_version DESC, id DESC`,
  ).all(normalizedOrganizationId, id) as Array<{
    id: number;
    knowledge_id: number;
    revision_version: number;
    accepted_evidence_ids_json: string;
    rejected_evidence_ids_json: string;
    rationale: string;
    adjudicated_by: string;
    created_at: string;
  }>;
  const adjudicationByVersion = new Map(adjudications.map((item) => [
    item.revision_version,
    {
      id: item.id,
      knowledgeId: item.knowledge_id,
      revisionVersion: item.revision_version,
      acceptedEvidenceIds: parseAdjudicationEvidenceIds(item.accepted_evidence_ids_json),
      rejectedEvidenceIds: parseAdjudicationEvidenceIds(item.rejected_evidence_ids_json),
      rationale: item.rationale,
      adjudicatedBy: item.adjudicated_by,
      createdAt: item.created_at,
    } satisfies EnterpriseKnowledgeAdjudicationView,
  ]));
  return revisions.map((revision) => {
    const adjudication = adjudicationByVersion.get(revision.version);
    return adjudication ? { ...revision, adjudication } : revision;
  });
}
