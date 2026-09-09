/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  OfficialPolicyDocument,
  PolicyDiagnosis,
  PolicyRegion,
  PolicySource,
} from './contracts.js';
import { sourceMatchesRegion } from './policyDomain.js';
import {
  policyRecheckCandidates,
  type PolicyRecheckDocument,
} from './policySources.js';
import {
  POLICY_BACKGROUND_RECORD_BYTES,
  type PolicyStore,
} from './policyStore.js';
import type { PolicyCollectionStep } from './policyCollectionCycle.js';

const bounded = { maxPayloadBytes: POLICY_BACKGROUND_RECORD_BYTES };
interface Recheck extends PolicyRecheckDocument {
  priority: boolean;
}
interface Candidates {
  cycle: string;
  documents: Recheck[];
}
interface Recommendation {
  workspaceKey: string;
  generation: number;
  region: PolicyRegion;
  cursor?: string;
  candidates: Array<{ id: string; date: string }>;
  index: number;
  attempts: number;
  spentMs: number;
  selected?: string;
}
export interface PolicyCollectionData {
  stage:
    | 'workspaces'
    | 'source-health'
    | 'documents'
    | 'diagnoses'
    | 'sources'
    | 'reconcile'
    | 'extract-authorize'
    | 'extract'
    | 'recommend-workspaces'
    | 'recommend-documents'
    | 'recommend-select'
    | 'recommend-model'
    | 'done';
  cursor?: string;
  analyzeEnabled: boolean;
  sourceIndex: number;
  sourceOrder: string[];
  sourceChecks?: Record<string, string>;
  pendingExtraction: string[];
  extractionIndex: number;
  extractionWorkspace?: string;
  errors: Array<{ sourceId: string; message: string }>;
  recommendation?: Recommendation;
}
export const initialPolicyCollection = (
  sources: readonly PolicySource[] = [],
): PolicyCollectionData => ({
  stage: 'workspaces',
  analyzeEnabled: false,
  sourceIndex: 0,
  sourceOrder: sources.map((source) => source.id),
  sourceChecks: {},
  pendingExtraction: [],
  extractionIndex: 0,
  errors: [],
});
export interface PolicyCollectionPorts {
  store: PolicyStore;
  sources: readonly PolicySource[];
  now(): Date;
  elapsedNow?: () => number;
  collectSource(
    source: PolicySource,
    known: readonly PolicyRecheckDocument[],
    priorityIds: ReadonlySet<string>,
    extractionSlots: number,
    signal: AbortSignal,
  ): Promise<{ pendingIds: string[]; error?: string }>;
  reconcile(doc: OfficialPolicyDocument): Promise<void>;
  interpret(
    id: string,
    signal: AbortSignal,
    workspaceKey: string,
  ): Promise<void>;
  recommendationTarget(
    workspaceKey: string,
  ): Promise<{ generation: number; region: PolicyRegion } | null>;
  recommendationCandidate(
    workspaceKey: string,
    generation: number,
    id: string,
  ): Promise<boolean>;
  recommend(
    workspaceKey: string,
    generation: number,
    id: string,
    signal: AbortSignal,
  ): Promise<void>;
}

async function retainRecheck(
  ports: PolicyCollectionPorts,
  cycle: string,
  doc: OfficialPolicyDocument,
  priority: boolean,
): Promise<void> {
  if (
    !ports.sources.some((source) => source.id === doc.sourceId) ||
    !policyRecheckCandidates(
      [doc],
      ports.now(),
      new Set(priority ? [doc.id] : []),
    ).length
  )
    return;
  const value: Recheck = {
    id: doc.id,
    url: doc.url,
    title: doc.title,
    sourceId: doc.sourceId,
    deadline: doc.deadline,
    fetchedAt: doc.fetchedAt,
    priority,
  };
  await ports.store.update<Candidates>(
    `collection-candidates:${doc.sourceId}`,
    (current) => {
      const previous = current?.cycle === cycle ? current.documents : [];
      const existing = previous.find((item) => item.id === doc.id);
      value.priority ||= existing?.priority ?? false;
      const documents = [
        ...previous.filter((item) => item.id !== doc.id),
        value,
      ]
        .sort(
          (a, b) =>
            Number(b.priority) - Number(a.priority) ||
            a.fetchedAt.localeCompare(b.fetchedAt),
        )
        .slice(0, 16);
      // At most 12 listing URLs can overlap these candidates. Keeping 16 light
      // records retains the original four rechecks, not sixteen network requests.
      return { cycle, documents };
    },
    bounded,
  );
}

/** Each returned local step handles one true keyset page. The persistent data
 * contains only small cursors, <=8 extraction IDs and <=500 recommendation IDs;
 * public bodies never accumulate across pages or sources. */
export function nextPolicyCollectionStep(
  ports: PolicyCollectionPorts,
  data: PolicyCollectionData,
): PolicyCollectionStep<PolicyCollectionData> | null {
  if (data.stage === 'done') return null;
  const kind =
    data.stage === 'sources' && data.sourceIndex < ports.sources.length
      ? 'source'
      : (data.stage === 'extract' &&
            data.extractionIndex < data.pendingExtraction.length) ||
          (data.stage === 'recommend-model' &&
            data.recommendation!.spentMs < 90_000)
        ? 'model'
        : 'page';
  return {
    kind,
    id: `${data.stage}:${data.sourceIndex}:${data.extractionIndex}:${data.cursor ?? ''}:${data.recommendation?.selected ?? ''}`,
    ...(data.stage === 'recommend-model' && kind === 'model'
      ? {
          maxMilliseconds: Math.max(
            1,
            Math.floor(90_000 - data.recommendation!.spentMs),
          ),
        }
      : {}),
    run: async (next, { cycle, signal }) => {
      const elapsedNow = ports.elapsedNow ?? (() => performance.now());
      const started = elapsedNow();
      const recommendation = next.recommendation;
      const store = ports.store;
      const get = <T>(key: string) =>
        store.getBounded<T>(key, POLICY_BACKGROUND_RECORD_BYTES);
      const page = (prefix: string, after?: string, limit = 32) =>
        store.keysPage(prefix, { after, limit });
      signal.throwIfAborted();
      if (recommendation && recommendation.spentMs >= 90_000) {
        next.cursor = recommendation.workspaceKey;
        next.recommendation = undefined;
        next.stage = 'recommend-workspaces';
        return next;
      }
      if (recommendation) {
        const current = await ports.recommendationTarget(
          recommendation.workspaceKey,
        );
        if (!current || current.generation !== recommendation.generation) {
          next.cursor = recommendation.workspaceKey;
          next.recommendation = undefined;
          next.stage = 'recommend-workspaces';
          return next;
        }
      }
      if (next.stage === 'workspaces') {
        const rows = await page('workspace:', next.cursor);
        for (const { key } of rows.rows) {
          signal.throwIfAborted();
          if ((await get<{ enabled: boolean }>(key))?.enabled) {
            next.analyzeEnabled = true;
            break;
          }
        }
        if (next.analyzeEnabled || !rows.nextCursor) {
          next.stage = 'source-health';
          next.cursor = undefined;
        } else next.cursor = rows.nextCursor;
      } else if (next.stage === 'source-health') {
        const rows = await page('source-status:', next.cursor);
        for (const { key } of rows.rows) {
          signal.throwIfAborted();
          const id = key.slice('source-status:'.length);
          if (!next.sourceOrder.includes(id)) continue;
          const value = await get<{ checkedAt: string }>(key);
          if (value?.checkedAt) next.sourceChecks![id] = value.checkedAt;
        }
        if (rows.nextCursor) next.cursor = rows.nextCursor;
        else {
          next.sourceOrder.sort((a, b) =>
            (next.sourceChecks?.[a] ?? '').localeCompare(
              next.sourceChecks?.[b] ?? '',
            ),
          );
          next.sourceChecks = undefined;
          next.stage = 'documents';
          next.cursor = undefined;
        }
      } else if (next.stage === 'documents' || next.stage === 'diagnoses') {
        const diagnosis = next.stage === 'diagnoses';
        const rows = await page(
          diagnosis ? 'diagnosis:' : 'document:',
          next.cursor,
        );
        for (const { key } of rows.rows) {
          signal.throwIfAborted();
          const id = diagnosis
            ? (await get<PolicyDiagnosis>(key))?.policyId
            : undefined;
          const doc = diagnosis
            ? id && (await get<OfficialPolicyDocument>(`document:${id}`))
            : await get<OfficialPolicyDocument>(key);
          if (doc) await retainRecheck(ports, cycle, doc, diagnosis);
        }
        if (rows.nextCursor) next.cursor = rows.nextCursor;
        else {
          next.stage = diagnosis ? 'sources' : 'diagnoses';
          next.cursor = undefined;
        }
      } else if (next.stage === 'sources') {
        const source = ports.sources.find(
          (source) => source.id === next.sourceOrder[next.sourceIndex],
        );
        if (!source) {
          next.stage = 'reconcile';
          next.cursor = undefined;
          return next;
        }
        const saved = await get<Candidates>(
          `collection-candidates:${source.id}`,
        );
        const candidates = saved?.cycle === cycle ? saved.documents : [];
        const result = await ports.collectSource(
          source,
          candidates,
          new Set(
            candidates.filter((item) => item.priority).map((item) => item.id),
          ),
          next.analyzeEnabled
            ? Math.max(0, 8 - next.pendingExtraction.length)
            : 0,
          signal,
        );
        for (const id of result.pendingIds) {
          if (next.pendingExtraction.length >= 8) break;
          if (!next.pendingExtraction.includes(id))
            next.pendingExtraction.push(id);
        }
        if (result.error)
          next.errors.push({ sourceId: source.id, message: result.error });
        next.sourceIndex++;
        if (next.sourceIndex === ports.sources.length) {
          next.stage = 'reconcile';
          next.cursor = undefined;
        }
      } else if (next.stage === 'reconcile') {
        // One bounded traversal reconciles all failed sources. Do not load the
        // whole public cache separately for every failed source.
        const rows = next.errors.length
          ? await page('document:', next.cursor)
          : { rows: [], nextCursor: undefined };
        for (const { key } of rows.rows) {
          signal.throwIfAborted();
          const doc = await get<OfficialPolicyDocument>(key);
          if (doc) await ports.reconcile(doc);
        }
        if (rows.nextCursor) next.cursor = rows.nextCursor;
        else {
          next.stage = 'extract-authorize';
          next.cursor = undefined;
        }
      } else if (next.stage === 'extract-authorize') {
        if (next.extractionIndex >= next.pendingExtraction.length) {
          next.stage = 'recommend-workspaces';
          next.cursor = undefined;
          return next;
        }
        const rows = await page('workspace:', next.cursor);
        for (const { key } of rows.rows) {
          signal.throwIfAborted();
          if ((await get<{ enabled: boolean }>(key))?.enabled) {
            next.extractionWorkspace = key;
            next.cursor = undefined;
            next.stage = 'extract';
            break;
          }
        }
        if (next.stage === 'extract-authorize') {
          if (rows.nextCursor) next.cursor = rows.nextCursor;
          else {
            next.stage = 'recommend-workspaces';
            next.cursor = undefined;
          }
        }
      } else if (next.stage === 'extract') {
        const id = next.pendingExtraction[next.extractionIndex];
        if (id) {
          await ports.interpret(id, signal, next.extractionWorkspace!);
          next.extractionIndex++;
        }
        next.extractionWorkspace = undefined;
        next.stage = 'extract-authorize';
      } else if (next.stage === 'recommend-workspaces') {
        if (!next.analyzeEnabled) {
          next.stage = 'done';
          return next;
        }
        const rows = await page('workspace:', next.cursor, 1);
        const key = rows.rows[0]?.key;
        if (!key) {
          next.stage = 'done';
          return next;
        }
        const target = await ports.recommendationTarget(key);
        if (!target) next.cursor = key;
        else {
          next.recommendation = {
            workspaceKey: key,
            ...target,
            candidates: [],
            index: 0,
            attempts: 0,
            spentMs: 0,
          };
          next.stage = 'recommend-documents';
        }
      } else if (next.stage === 'recommend-documents') {
        const target = next.recommendation!;
        const rows = await page('document:', target.cursor);
        for (const { key } of rows.rows) {
          signal.throwIfAborted();
          const doc = await get<OfficialPolicyDocument>(key);
          if (!doc || !sourceMatchesRegion(doc, target.region)) continue;
          target.candidates.push({
            id: doc.id,
            date: doc.publishedAt ?? doc.fetchedAt,
          });
          target.candidates.sort(
            (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
          );
          if (target.candidates.length > 500) target.candidates.pop();
        }
        if (rows.nextCursor) target.cursor = rows.nextCursor;
        else {
          target.cursor = undefined;
          next.stage = 'recommend-select';
        }
      } else if (next.stage === 'recommend-select') {
        const target = next.recommendation!;
        let checked = 0;
        while (
          target.index < target.candidates.length &&
          target.attempts < 8 &&
          checked++ < 32
        ) {
          signal.throwIfAborted();
          const id = target.candidates[target.index++].id;
          if (
            await ports.recommendationCandidate(
              target.workspaceKey,
              target.generation,
              id,
            )
          ) {
            target.selected = id;
            next.stage = 'recommend-model';
            break;
          }
        }
        if (
          next.stage !== 'recommend-model' &&
          (target.index >= target.candidates.length || target.attempts >= 8)
        ) {
          next.cursor = target.workspaceKey;
          next.recommendation = undefined;
          next.stage = 'recommend-workspaces';
        }
      } else if (next.stage === 'recommend-model') {
        const target = next.recommendation!;
        await ports.recommend(
          target.workspaceKey,
          target.generation,
          target.selected!,
          signal,
        );
        target.attempts++;
        target.selected = undefined;
        next.stage = 'recommend-select';
      }
      if (recommendation)
        recommendation.spentMs += Math.max(0, elapsedNow() - started);
      return next;
    },
  };
}
