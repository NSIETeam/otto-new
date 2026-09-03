/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { PolicyStore } from './policyStore.js';
import type {
  OfficialPolicyDocument,
  PolicyAction,
  PolicyActor,
  PolicyAssessment,
  PolicyDiagnosis,
  PolicyEnterpriseProfile,
  PolicyIntelligenceState,
  PolicyMaterialState,
  PolicyModel,
  PolicySource,
  PolicyFeedback,
} from './contracts.js';
import {
  corePolicyProfile,
  DEFAULT_POLICY_CATEGORIES,
  evaluatePolicyConclusion,
  missingPolicyProfileFields,
  normalizePolicyRegion,
  policyApplicationStatus,
  policyHash,
  policyProfileVersion,
  policyRecommendationGroup,
  policyValidityStatus,
  sourceMatchesRegion,
  validatePolicyEvidence,
} from './policyDomain.js';
import { collectPolicySource } from './policySources.js';
import { PolicyOperationError } from './policyErrors.js';
import { knownPolicyFact } from './policyDomain.js';
import {
  estimatePolicySupport,
  evaluateExclusions,
  policyFactKeys,
  policyModelProfile,
  policyQuestion,
  policyRulesHash,
  policyQuote,
  POLICY_INTERPRETATION_VERSION,
} from './policyEligibility.js';

interface Workspace {
  enabled: boolean;
  profile: PolicyEnterpriseProfile;
  generation: number;
  assessments: PolicyAssessment[];
  enabledBy?: string;
  analysisError?: string;
}
interface CollectionStatus {
  at: string;
  errors: Array<{ sourceId: string; message: string }>;
}
const blank = (): Workspace => ({
  enabled: false,
  profile: {},
  generation: 0,
  assessments: [],
});
const orgKey = (actor: PolicyActor): string =>
  `workspace:${policyHash(actor.organizationId)}`;
const userKey = (actor: PolicyActor): string =>
  `${policyHash([actor.organizationId, actor.id])}:`;
const texts = [
  'organizationName',
  'registeredRegion',
  'industry',
  'establishedAt',
  'enterpriseType',
  'mainBusiness',
  'notes',
];
const numbers = [
  'employeeCount',
  'annualRevenueCny',
  'rdExpenseCny',
  'fiscalYear',
];
const arrays = ['qualifications', 'productsServices', 'capabilities'];
export function sanitizePolicyProfile(
  raw: PolicyEnterpriseProfile,
): PolicyEnterpriseProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new PolicyOperationError('企业资料格式错误');
  const result: PolicyEnterpriseProfile = {};
  for (const key of texts)
    if (Object.hasOwn(raw, key)) {
      if (typeof raw[key] !== 'string' || (raw[key] as string).length > 2000)
        throw new PolicyOperationError('企业资料字段过长或格式错误');
      result[key] = (raw[key] as string).trim();
    }
  for (const key of numbers)
    if (Object.hasOwn(raw, key)) {
      if (
        typeof raw[key] !== 'number' ||
        !Number.isFinite(raw[key]) ||
        (raw[key] as number) < 0 ||
        (raw[key] as number) > 1e15
      )
        throw new PolicyOperationError('企业数值资料格式错误');
      result[key] = raw[key];
    }
  for (const key of arrays)
    if (Object.hasOwn(raw, key)) {
      const value = raw[key];
      if (
        !Array.isArray(value) ||
        value.length > 40 ||
        value.some((item) => typeof item !== 'string' || item.length > 200)
      )
        throw new PolicyOperationError('企业资料列表格式错误');
      result[key] = value.map((item: string) => item.trim()).filter(Boolean);
    }
  if (Object.hasOwn(raw, 'region'))
    result.region = normalizePolicyRegion(raw.region);
  if (Object.hasOwn(raw, 'registeredRegion'))
    result.region = normalizePolicyRegion(result.registeredRegion);
  return result;
}

export class EnterprisePolicyService {
  private readonly controllers = new Map<string, Set<AbortController>>();
  constructor(
    private readonly options: {
      store: PolicyStore;
      model?: PolicyModel;
      sources: readonly PolicySource[];
      getActor(id: string): Promise<PolicyActor | null>;
      getBaseProfile?(organizationId: string): Promise<PolicyEnterpriseProfile>;
      now?: () => Date;
      fetchImpl?: typeof fetch;
      dailyLimit?: number;
    },
  ) {}
  private get store(): PolicyStore {
    return this.options.store;
  }
  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
  private async actor(id: string): Promise<PolicyActor> {
    const actor = await this.options.getActor(id);
    if (!actor?.active || !actor.organizationId || actor.id !== id)
      throw new PolicyOperationError('企业账号不可用');
    return actor;
  }
  private async workspace(actor: PolicyActor): Promise<Workspace> {
    const workspace =
      (await this.store.get<Workspace>(orgKey(actor))) ?? blank();
    const base =
      (await this.options.getBaseProfile?.(actor.organizationId)) ?? {};
    return {
      ...workspace,
      profile: { ...sanitizePolicyProfile(base), ...workspace.profile },
    };
  }
  private day(): string {
    return new Date(this.now().getTime() + 8 * 3600_000)
      .toISOString()
      .slice(0, 10);
  }
  private limit(): number {
    return Math.max(1, Math.min(100, this.options.dailyLimit ?? 24));
  }
  private usageKey(actor: PolicyActor): string {
    return `usage:${orgKey(actor)}:${this.day()}`;
  }
  private async document(id?: string): Promise<OfficialPolicyDocument> {
    const doc =
      id && (await this.store.get<OfficialPolicyDocument>(`document:${id}`));
    if (!doc) throw new PolicyOperationError('政策不存在');
    return doc;
  }
  private stale(
    d: PolicyDiagnosis,
    workspace: Workspace,
    doc?: OfficialPolicyDocument,
  ): boolean {
    return (
      !doc ||
      d.factVersion !== policyProfileVersion(workspace.profile) ||
      d.policyContentHash !== doc.contentHash ||
      d.policyRulesHash !== policyRulesHash(doc) ||
      d.policyVersion !== doc.version ||
      doc.sourceStatus !== 'verified' ||
      ['closed', 'withdrawn', 'expired', 'unknown'].includes(
        policyApplicationStatus(doc, this.now()),
      )
    );
  }
  async state(accountId: string): Promise<PolicyIntelligenceState> {
    const actor = await this.actor(accountId);
    const workspace = await this.workspace(actor);
    const region = normalizePolicyRegion(
      workspace.profile.region ?? workspace.profile.registeredRegion,
    );
    const policies = (
      await this.store.list<OfficialPolicyDocument>('document:')
    )
      .map((row) => row.value)
      .filter((doc) => sourceMatchesRegion(doc, region));
    policies.sort((a, b) =>
      (b.publishedAt ?? b.fetchedAt).localeCompare(
        a.publishedAt ?? a.fetchedAt,
      ),
    );
    const diagnoses = actor.isAdmin
      ? (
          await this.store.list<PolicyDiagnosis>(`diagnosis:${userKey(actor)}`)
        ).map(({ value }) => ({
          ...value,
          stale: this.stale(
            value,
            workspace,
            policies.find((doc) => doc.id === value.policyId),
          ),
        }))
      : [];
    const collection =
      await this.store.get<CollectionStatus>('collection:status');
    const relevantSources = new Set(
      this.options.sources
        .filter((source) => sourceMatchesRegion(source, region))
        .map((source) => source.id),
    );
    const lastError =
      [
        ...(collection?.errors ?? [])
          .filter((error) => relevantSources.has(error.sourceId))
          .map((error) => error.message),
        ...(workspace.analysisError ? [workspace.analysisError] : []),
      ].join('；') || undefined;
    const levels = ['district', 'city', 'province', 'national'] as const;
    const feedbackRows = actor.isAdmin
      ? await this.store.list<PolicyFeedback>(`feedback:${userKey(actor)}`)
      : [];
    return {
      enabled: workspace.enabled,
      profile: actor.isAdmin
        ? workspace.profile
        : corePolicyProfile(workspace.profile),
      policies: policies.slice(0, 500),
      assessments: (actor.isAdmin ? workspace.assessments : [])
        .filter(
          (item) =>
            item.profileFingerprint ===
              policyProfileVersion(corePolicyProfile(workspace.profile)) &&
            policies.some(
              (doc) =>
                doc.id === item.policyId &&
                doc.contentHash === item.policyContentHash &&
                item.policyRulesHash === policyRulesHash(doc) &&
                ['open', 'upcoming', 'evergreen'].includes(
                  policyApplicationStatus(doc, this.now()),
                ) &&
                doc.sourceStatus === 'verified',
            ),
        )
        .map((item) => ({
          ...item,
          group: policyRecommendationGroup(
            policyApplicationStatus(
              policies.find((doc) => doc.id === item.policyId)!,
              this.now(),
            ),
            item.status,
            item.group !== 'all',
          ),
        })),
      diagnoses: diagnoses.sort(
        (a, b) =>
          Number(a.stale) - Number(b.stale) ||
          b.assessedAt.localeCompare(a.assessedAt),
      ),
      materials: Object.fromEntries(
        (actor.isAdmin
          ? await this.store.list<PolicyMaterialState>(
              `material:${orgKey(actor)}:`,
            )
          : []
        ).map(({ key, value }) => [key.split(':').slice(-2).join(':'), value]),
      ),
      canManage: actor.isAdmin,
      region,
      coverage: levels
        .filter(
          (level) => level !== 'province' || region.province !== region.city,
        )
        .map((level) => {
          const count = this.options.sources.filter(
            (source) =>
              source.level === level && sourceMatchesRegion(source, region),
          ).length;
          return {
            level,
            regionLabel:
              level === 'national'
                ? '国家级'
                : level === 'province'
                  ? (region.province ?? '省份待补充')
                  : level === 'city'
                    ? (region.city ?? '城市待补充')
                    : (region.district ?? '区县待补充'),
            sourceCount: count,
            status: count ? 'configured' : 'missing',
          };
        }),
      categories: [
        ...new Set([
          ...DEFAULT_POLICY_CATEGORIES,
          ...policies.flatMap((doc) => doc.categories),
        ]),
      ],
      missingProfileFields: missingPolicyProfileFields(workspace.profile),
      syncStatus: lastError ? 'error' : 'idle',
      lastSyncAt: collection?.at,
      lastError,
      modelName: this.options.model?.name ?? '服务端尚未配置分析模型',
      usedAnalysesToday:
        (await this.store.get<number>(this.usageKey(actor))) ?? 0,
      dailyAnalysisLimit: this.limit(),
      feedback: feedbackRows
        .map(({ value }) => value)
        .filter((v) => v.outcome)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      feedbackRevisions: Object.fromEntries(
        feedbackRows.map(({ value }) => [value.policyId, value.revision]),
      ),
    };
  }
  async act(
    accountId: string,
    input: PolicyAction,
  ): Promise<PolicyIntelligenceState> {
    const actor = await this.actor(accountId);
    if (!actor.isAdmin)
      throw new PolicyOperationError(
        '仅企业管理员可管理政策服务和发起企业诊断',
      );
    let workspace = await this.workspace(actor);
    if (input.action === 'configure') {
      if (typeof input.enabled !== 'boolean')
        throw new PolicyOperationError('开关参数错误');
      if (input.enabled && input.consent !== true)
        throw new PolicyOperationError('请明确同意启用企业资料分析');
      await this.store.update<Workspace>(orgKey(actor), (value) => ({
        ...(value ?? blank()),
        enabled: input.enabled!,
        enabledBy: input.enabled ? actor.id : value?.enabledBy,
        generation: (value?.generation ?? 0) + 1,
      }));
      if (!input.enabled)
        this.controllers
          .get(orgKey(actor))
          ?.forEach((controller) => controller.abort());
    } else if (input.action === 'profile') {
      if (input.consent !== true)
        throw new PolicyOperationError('请同意将资料保存为企业共享资料');
      const patch = sanitizePolicyProfile(input.profile!);
      await this.store.update<Workspace>(orgKey(actor), (value) => ({
        ...(value ?? blank()),
        profile: { ...value?.profile, ...patch },
        generation: (value?.generation ?? 0) + 1,
        assessments: [],
      }));
    } else if (input.action === 'diagnose' || input.action === 'answer') {
      if (!workspace.enabled)
        throw new PolicyOperationError('请先开启政策智能服务');
      if (input.action === 'diagnose' && input.consent !== true)
        throw new PolicyOperationError('请同意由已配置模型分析本次企业资料');
      const prefix = `diagnosis:${userKey(actor)}`;
      let previous: PolicyDiagnosis | undefined;
      if (input.action === 'answer') {
        previous =
          (await this.store.get<PolicyDiagnosis>(
            `${prefix}${input.diagnosisId}`,
          )) ?? undefined;
        if (!previous) throw new PolicyOperationError('诊断不存在或无权访问');
        if (input.revision !== previous.revision)
          throw new PolicyOperationError('诊断已更新，请刷新后重试');
      }
      let doc = await this.document(previous?.policyId ?? input.policyId);
      if (
        !sourceMatchesRegion(
          doc,
          normalizePolicyRegion(
            workspace.profile.region ?? workspace.profile.registeredRegion,
          ),
        )
      )
        throw new PolicyOperationError('政策不属于企业当前所在地');
      if (
        !previous &&
        doc.sourceStatus === 'verified' &&
        !doc.attachments.some((a) => !a.parsed) &&
        (doc.interpretationStatus !== 'ready' ||
          doc.interpretationVersion !== POLICY_INTERPRETATION_VERSION)
      )
        doc = await this.interpret(doc, AbortSignal.timeout(90_000));
      if (
        doc.sourceStatus !== 'verified' ||
        doc.interpretationStatus !== 'ready' ||
        doc.interpretationVersion !== POLICY_INTERPRETATION_VERSION ||
        !doc.exclusionsReviewed ||
        doc.attachments.some((item) => !item.parsed)
      )
        throw new PolicyOperationError(
          '政策原文或附件尚未完成核验，请先查看官方原文',
        );
      if (
        !['open', 'upcoming', 'evergreen'].includes(
          policyApplicationStatus(doc, this.now()),
        )
      )
        throw new PolicyOperationError(
          '本批次已截止、废止或受理时间尚未核验，请查看最新原文',
        );
      if (previous && this.stale(previous, workspace, doc))
        throw new PolicyOperationError('政策或企业资料已更新，请重新诊断');
      const answers = { ...previous?.answers };
      let sharedPatch: PolicyEnterpriseProfile | undefined;
      if (previous) {
        if (!input.field || !policyFactKeys(doc).includes(input.field))
          throw new PolicyOperationError('不是本次政策诊断所需字段');
        if (
          input.value !== null &&
          [...texts, ...numbers, ...arrays].includes(input.field)
        )
          sanitizePolicyProfile({ [input.field]: input.value });
        if (
          input.value === undefined ||
          JSON.stringify(input.value).length > 4000 ||
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(input.field) ||
          ['constructor', 'prototype', '__proto__'].includes(input.field) ||
          (input.value !== null &&
            !['string', 'number', 'boolean'].includes(typeof input.value) &&
            (!Array.isArray(input.value) ||
              input.value.some((value) => typeof value !== 'string')))
        )
          throw new PolicyOperationError('诊断回答格式错误');
        answers[input.field] = input.value;
        if (input.saveToEnterprise) {
          if (
            input.consent !== true ||
            input.value === null ||
            ![...texts, ...numbers, ...arrays].includes(input.field)
          )
            throw new PolicyOperationError(
              '共享企业资料需要单独同意并提供支持的确定字段；其他信息仅保存在本次诊断',
            );
          sharedPatch = sanitizePolicyProfile({ [input.field]: input.value });
        }
      } else {
        const existing = (await this.store.list<PolicyDiagnosis>(prefix)).find(
          ({ value }) =>
            value.policyId === doc.id && !this.stale(value, workspace, doc),
        );
        if (existing) return this.state(accountId);
      }
      const id = previous?.id ?? randomUUID();
      const leaseKey = `lease:${prefix}${doc.id}`;
      const token = randomUUID();
      const clock = this.now().getTime();
      await this.store.update<{ token: string; until: number }>(
        leaseKey,
        (lease) => {
          if (lease && lease.until > clock)
            throw new PolicyOperationError('诊断正在更新，请稍后刷新');
          return { token, until: clock + 180_000 };
        },
      );
      try {
        if (sharedPatch) {
          await this.store.update<Workspace>(orgKey(actor), (value) => {
            if (!value?.enabled || value.generation !== workspace.generation)
              throw new PolicyOperationError('企业资料或服务开关已更新');
            return {
              ...value,
              profile: { ...value.profile, ...sharedPatch },
              generation: value.generation + 1,
              assessments: [],
            };
          });
          workspace = await this.workspace(actor);
        }
        const assessment = await this.assess(actor, workspace, doc, {
          ...workspace.profile,
          ...answers,
        });
        const unanswered = assessment.missingFields.find(
          (field) => !Object.hasOwn(answers, field),
        );
        const diagnosis: PolicyDiagnosis = {
          ...assessment,
          id,
          accountId,
          policyVersion: doc.version,
          revision: (previous?.revision ?? 0) + 1,
          answers,
          factVersion: policyProfileVersion(workspace.profile),
          stale: false,
          ...(unanswered
            ? {
                question: policyQuestion(doc, unanswered),
              }
            : {}),
        };
        await this.store.update<PolicyDiagnosis>(
          `${prefix}${id}`,
          (current) => {
            if (previous && current?.revision !== previous.revision)
              throw new PolicyOperationError('诊断已更新，请刷新');
            return diagnosis;
          },
        );
      } finally {
        await this.store.update<{ token: string; until: number }>(
          leaseKey,
          (lease) => (lease?.token === token ? { token, until: 0 } : lease!),
        );
      }
    } else if (
      input.action === 'feedback' ||
      input.action === 'delete-feedback'
    ) {
      if (input.consent !== true)
        throw new PolicyOperationError(
          '请确认保存或删除反馈；反馈不会改变官方申报条件',
        );
      const doc = await this.document(input.policyId);
      if (
        !sourceMatchesRegion(
          doc,
          normalizePolicyRegion(
            workspace.profile.region ?? workspace.profile.registeredRegion,
          ),
        )
      )
        throw new PolicyOperationError('政策不属于企业当前所在地');
      const key = `feedback:${userKey(actor)}${doc.id}`;
      if (input.action === 'delete-feedback') {
        // Keep a revision tombstone so a delayed old write cannot resurrect deleted feedback.
        await this.store.update<PolicyFeedback>(key, (previous) => {
          if (!previous?.outcome || previous.revision !== input.revision)
            throw new PolicyOperationError('反馈已更新，请刷新');
          return {
            policyId: doc.id,
            revision: previous.revision + 1,
          } as PolicyFeedback;
        });
      } else {
        const feedback = input.feedback;
        if (
          !feedback ||
          !['submitted', 'approved', 'rejected', 'dispute'].includes(
            feedback.outcome,
          ) ||
          ![
            'none',
            'eligibility',
            'materials',
            'quota',
            'competition',
            'other',
          ].includes(feedback.reason) ||
          typeof feedback.note !== 'string' ||
          feedback.note.length > 2000 ||
          !Number.isSafeInteger(input.revision) ||
          input.revision! < 0 ||
          (['rejected', 'dispute'].includes(feedback.outcome) &&
            (feedback.reason === 'none' || !feedback.note.trim()))
        )
          throw new PolicyOperationError('请填写反馈类型、原因和必要说明');
        const diagnosis = (
          await this.store.list<PolicyDiagnosis>(`diagnosis:${userKey(actor)}`)
        ).find(({ value }) => value.policyId === doc.id)?.value;
        await this.store.update<PolicyFeedback>(key, (previous) => {
          if ((previous?.revision ?? 0) !== input.revision)
            throw new PolicyOperationError('反馈已更新，请刷新');
          return {
            policyId: doc.id,
            policyContentHash: doc.contentHash,
            policyVersion: doc.version,
            diagnosisId: diagnosis?.id,
            outcome: feedback.outcome,
            reason: feedback.reason,
            note: feedback.note.trim(),
            reviewStatus:
              feedback.outcome === 'dispute' ? 'pending' : 'recorded',
            revision: (previous?.revision ?? 0) + 1,
            updatedAt: this.now().toISOString(),
          };
        });
      }
    } else if (input.action === 'material') {
      const doc = await this.document(input.policyId);
      if (
        !doc.materials.some((item) => item.id === input.materialId) ||
        !['ready', 'unknown', 'missing'].includes(input.materialStatus ?? '')
      )
        throw new PolicyOperationError('材料不存在或状态错误');
      await this.store.update<PolicyMaterialState>(
        `material:${orgKey(actor)}:${doc.id}:${input.materialId}`,
        () => ({
          status: input.materialStatus!,
          version: doc.contentHash,
          updatedAt: this.now().toISOString(),
          updatedBy: accountId,
        }),
      );
    } else if (input.action === 'delete-diagnosis') {
      if (
        !input.diagnosisId ||
        !(await this.store.get(
          `diagnosis:${userKey(actor)}${input.diagnosisId}`,
        ))
      )
        throw new PolicyOperationError('诊断不存在');
      await this.store.remove(
        `diagnosis:${userKey(actor)}${input.diagnosisId}`,
      );
    } else if (input.action === 'sync') {
      // Refresh recommendations only. Public collection is independent of client lifecycle.
      if (!workspace.enabled)
        throw new PolicyOperationError('请先开启政策智能服务');
      await this.recommend(actor, workspace);
    } else throw new PolicyOperationError('不支持的政策操作');
    return this.state(accountId);
  }
  private async assess(
    actor: PolicyActor,
    workspace: Workspace,
    doc: OfficialPolicyDocument,
    profile: PolicyEnterpriseProfile,
    parentSignal: AbortSignal = new AbortController().signal,
  ): Promise<PolicyAssessment> {
    parentSignal.throwIfAborted();
    const before = await this.workspace(actor);
    const beforeActor = await this.actor(actor.id);
    if (
      !before.enabled ||
      !beforeActor.isAdmin ||
      beforeActor.organizationId !== actor.organizationId ||
      before.generation !== workspace.generation ||
      policyProfileVersion(before.profile) !==
        policyProfileVersion(workspace.profile)
    )
      throw new PolicyOperationError(
        '企业资料或服务开关已更新，本次分析已取消',
      );
    const exclusions = evaluateExclusions(doc, profile);
    const policyHit = exclusions.some(
      (e) => !e.scopeConditionIds?.length && e.result === 'hit',
    );
    const policyPending = exclusions.some(
      (e) => !e.scopeConditionIds?.length && e.result === 'unknown',
    );
    const preconditions = doc.conditions.map((condition) =>
      validatePolicyEvidence(
        { ...condition, result: 'unknown' as const },
        doc.bodyText,
        profile,
      ),
    );
    const hardGap =
      evaluatePolicyConclusion(
        doc.conditionTree,
        Object.fromEntries(preconditions.map((c) => [c.id, c.result])),
      ) === 'has_gaps';
    const skipModel = policyHit || policyPending || hardGap;
    if (!skipModel && !this.options.model)
      throw new PolicyOperationError('企业服务端尚未配置政策分析模型');
    if (!skipModel)
      await this.store.update<number>(this.usageKey(actor), (used) => {
        if ((used ?? 0) >= this.limit())
          throw new PolicyOperationError(
            '今日企业分析额度已用完，已有结果仍可查看',
          );
        return (used ?? 0) + 1;
      });
    const controller = new AbortController();
    const key = orgKey(actor);
    const controllers = this.controllers.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(key, controllers);
    try {
      const signal = AbortSignal.any([
        parentSignal,
        controller.signal,
        AbortSignal.timeout(90_000),
      ]);
      signal.throwIfAborted();
      const result: Awaited<ReturnType<PolicyModel['analyze']>> = skipModel
        ? { relevant: true, summary: '', conditions: preconditions }
        : await this.options.model!.analyze(
            doc,
            policyModelProfile(doc, profile),
            signal,
          );
      if (signal.aborted)
        throw new PolicyOperationError(
          '企业资料或服务开关已更新、分析超时或服务器停止，本次分析已取消',
        );
      const latest = await this.workspace(actor);
      const currentActor = await this.actor(actor.id);
      if (
        !currentActor.isAdmin ||
        currentActor.organizationId !== actor.organizationId ||
        !latest.enabled ||
        latest.generation !== workspace.generation ||
        policyProfileVersion(latest.profile) !==
          policyProfileVersion(workspace.profile) ||
        controller.signal.aborted
      )
        throw new PolicyOperationError(
          '企业资料或服务开关已更新，本次分析已取消',
        );
      const currentDoc = await this.document(doc.id);
      if (
        currentDoc.contentHash !== doc.contentHash ||
        policyRulesHash(currentDoc) !== policyRulesHash(doc) ||
        currentDoc.sourceStatus !== 'verified'
      )
        throw new PolicyOperationError('政策原文已更新，请重新分析');
      if (
        !['open', 'upcoming', 'evergreen'].includes(
          policyApplicationStatus(currentDoc, this.now()),
        )
      )
        throw new PolicyOperationError(
          '本批次已截止或受理状态已变化，请查看最新原文',
        );
      const conditions = doc.conditions.map((condition) => {
        const judgment = result.conditions.find(
          (item) => item.id === condition.id,
        );
        const validated = validatePolicyEvidence(
          { ...condition, result: judgment?.result ?? 'unknown' },
          doc.bodyText,
          profile,
        );
        const scoped = exclusions.filter((e) =>
          e.scopeConditionIds?.includes(condition.id),
        );
        if (scoped.some((e) => e.result === 'hit'))
          return {
            ...validated,
            result: 'gap' as const,
            evidence: '该申报路径命中排除条款，见排除核验。',
          };
        if (
          validated.result !== 'gap' &&
          scoped.some((e) => e.result === 'unknown')
        )
          return {
            ...validated,
            result: 'unknown' as const,
            evidence: '该路径的排除条件或例外尚未核验。',
          };
        return validated;
      });
      let status = evaluatePolicyConclusion(
        doc.conditionTree,
        Object.fromEntries(
          conditions.map((condition) => [condition.id, condition.result]),
        ),
      );
      const warnings: string[] = [];
      if (policyValidityStatus(doc, this.now()) === 'unknown')
        warnings.push(
          '原文未明确完整的法律有效期；申报窗口与文件有效性分开显示，不据此声称长期有效。',
        );
      if (
        !doc.exclusionsReviewed ||
        doc.interpretationVersion !== POLICY_INTERPRETATION_VERSION
      ) {
        warnings.push(
          '排除条款尚未按新版规则完成核验，请更新解读后再判断资格。',
        );
        if (!['has_gaps', 'unlikely'].includes(status)) status = 'unknown';
      }
      if (result.refutation?.checked)
        for (const concern of result.refutation.concerns) {
          policyQuote(concern.quote, doc.bodyText);
          warnings.push(`需复核：${concern.note}（原文：${concern.quote}）`);
          if (status === 'likely_eligible') status = 'unknown';
        }
      if (!skipModel && !result.refutation?.checked) {
        warnings.push('模型未完成反向核验，暂不生成肯定资格结论。');
        if (status === 'likely_eligible') status = 'unknown';
      }
      if (policyHit) status = 'unlikely';
      else if (policyPending && status === 'likely_eligible')
        status = 'unknown';
      const missingFields = [
        ...new Set([
          ...exclusions
            .filter((e) => e.result === 'unknown')
            .flatMap((e) => e.missingFields),
          ...conditions
            .filter((item) => item.result === 'unknown')
            .flatMap((item) =>
              item.factKeys.filter((field) => !knownPolicyFact(profile[field])),
            ),
        ]),
      ];
      if (status !== 'unknown') missingFields.length = 0;
      if (
        status === 'likely_eligible' &&
        doc.supportEstimate?.kind === 'rate' &&
        !knownPolicyFact(profile[doc.supportEstimate.field])
      )
        missingFields.push(doc.supportEstimate.field);
      return {
        policyId: doc.id,
        status,
        summary:
          status === 'likely_eligible'
            ? '现有资料支持已核验条件；最终以主管部门审核为准。'
            : status === 'unlikely'
              ? '已确认命中本批次排除条件，当前不符合。可查看依据或记录纠错反馈。'
              : status === 'has_gaps'
                ? '本批次存在不满足的必需条件；不能作为当前可申报项目，后续准备也不代表本批次有资格。'
                : '资料或条件证据不足，暂时不能判定满足。',
        conditions,
        exclusions,
        warnings,
        supportEstimate: estimatePolicySupport(doc, profile, status),
        gaps: [
          ...exclusions.filter((e) => e.result === 'hit').map((e) => e.label),
          ...conditions
            .filter((item) => item.result === 'gap')
            .map((item) => item.label),
        ],
        missingFields: policyHit ? [] : missingFields,
        resourceConnections: doc.resources.map(
          (item) => `${item.label}：${item.url}`,
        ),
        assessedAt: this.now().toISOString(),
        profileFingerprint: policyProfileVersion(profile),
        policyContentHash: doc.contentHash,
        policyRulesHash: policyRulesHash(doc),
        group: policyRecommendationGroup(
          policyApplicationStatus(doc, this.now()),
          status,
          result.relevant,
        ),
        modelProvider: skipModel
          ? '证据规则核验（本次未调用模型）'
          : this.options.model!.name,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    } finally {
      controllers.delete(controller);
      if (!controllers.size) this.controllers.delete(key);
    }
  }
  private async recommend(
    actor: PolicyActor,
    workspace: Workspace,
    parentSignal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const profile = corePolicyProfile(workspace.profile);
    if (missingPolicyProfileFields(profile).length) return;
    const leaseKey = `recommend-lease:${orgKey(actor)}`;
    const token = randomUUID();
    const clock = this.now().getTime();
    await this.store.update<{ token: string; until: number }>(
      leaseKey,
      (lease) => {
        if (lease && lease.until > clock)
          throw new PolicyOperationError('政策推荐正在更新，请稍后刷新');
        return { token, until: clock + 180_000 };
      },
    );
    const controller = new AbortController();
    const key = orgKey(actor);
    const controllers = this.controllers.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(key, controllers);
    const signal = AbortSignal.any([
      parentSignal,
      controller.signal,
      AbortSignal.timeout(90_000),
    ]);
    try {
      const state = await this.state(actor.id);
      let count = 0;
      for (const candidate of state.policies) {
        signal.throwIfAborted();
        if (count >= 8) break;
        if (
          candidate.sourceStatus !== 'verified' ||
          candidate.attachments.some((item) => !item.parsed) ||
          state.assessments.some((item) => item.policyId === candidate.id)
        )
          continue;
        // An already classified, non-actionable document costs no model work.
        // Do not let the first eight closed/reference entries block later policies.
        if (
          candidate.interpretationStatus === 'ready' &&
          candidate.interpretationVersion === POLICY_INTERPRETATION_VERSION &&
          !['open', 'upcoming', 'evergreen'].includes(
            policyApplicationStatus(candidate, this.now()),
          )
        )
          continue;
        count++;
        const doc =
          candidate.interpretationStatus === 'ready' &&
          candidate.interpretationVersion === POLICY_INTERPRETATION_VERSION
            ? candidate
            : await this.interpret(candidate, signal);
        if (
          doc.interpretationStatus !== 'ready' ||
          doc.interpretationVersion !== POLICY_INTERPRETATION_VERSION ||
          !doc.exclusionsReviewed ||
          ['closed', 'reference', 'unknown', 'withdrawn', 'expired'].includes(
            policyApplicationStatus(doc, this.now()),
          )
        )
          continue;
        const assessment = await this.assess(
          actor,
          workspace,
          doc,
          profile,
          signal,
        );
        await this.store.update<Workspace>(orgKey(actor), (value) => {
          if (!value?.enabled || value.generation !== workspace.generation)
            throw new PolicyOperationError('企业资料已更新');
          return {
            ...value,
            analysisError: undefined,
            assessments: [
              ...value.assessments.filter((item) => item.policyId !== doc.id),
              assessment,
            ].slice(-500),
          };
        });
      }
    } finally {
      controllers.delete(controller);
      if (!controllers.size) this.controllers.delete(key);
      await this.store.update<{ token: string; until: number }>(
        leaseKey,
        (lease) => (lease?.token === token ? { token, until: 0 } : lease!),
      );
    }
  }
  private async interpret(
    doc: OfficialPolicyDocument,
    signal: AbortSignal,
  ): Promise<OfficialPolicyDocument> {
    if (!this.options.model) return doc;
    const leaseKey = `extract-lease:${doc.id}`;
    const token = randomUUID();
    let accepted = false;
    await this.store.update<{ token: string; until: number }>(
      leaseKey,
      (lease) => {
        if (lease && lease.until > this.now().getTime()) return lease;
        accepted = true;
        return { token, until: this.now().getTime() + 180000 };
      },
    );
    if (!accepted) return this.document(doc.id);
    try {
      const cached = await this.document(doc.id);
      if (
        cached.contentHash === doc.contentHash &&
        cached.interpretationStatus === 'ready' &&
        cached.interpretationVersion === POLICY_INTERPRETATION_VERSION
      )
        return cached;
      let permitted = false;
      await this.store.update<number>(
        `extraction-usage:${this.day()}`,
        (used) => {
          if ((used ?? 0) >= 48) return used!;
          permitted = true;
          return (used ?? 0) + 1;
        },
      );
      if (!permitted) return doc;
      let next = doc;
      try {
        next = {
          ...doc,
          // Re-extraction replaces inferred metadata; omitted fields are unknown,
          // not permission to retain unverified dates/effectiveness from an old parser.
          publishedAt: undefined,
          startsAt: undefined,
          deadline: undefined,
          validFrom: undefined,
          validUntil: undefined,
          evergreen: undefined,
          governance: undefined,
          supportEstimate: undefined,
          referenceOnly: false,
          error: undefined,
          ...(await this.options.model.extract(doc, signal)),
          id: doc.id,
          url: doc.url,
          sourceId: doc.sourceId,
          level: doc.level,
          region: doc.region,
          contentHash: doc.contentHash,
          version: doc.version,
          bodyText: doc.bodyText,
          sourceStatus: 'verified',
        };
        signal.throwIfAborted();
        if (
          !next.exclusionsReviewed ||
          next.interpretationVersion !== POLICY_INTERPRETATION_VERSION
        )
          throw new Error('新版排除核验未完成');
      } catch {
        next = {
          ...doc,
          interpretationStatus: 'failed',
          error: '结构化解读未通过校验，请查看原文',
        };
      }
      signal.throwIfAborted();
      return await this.store.update<OfficialPolicyDocument>(
        `document:${doc.id}`,
        (current) =>
          current &&
          (current.contentHash !== doc.contentHash ||
            current.sourceStatus !== 'verified')
            ? current
            : next,
      );
    } finally {
      await this.store.update<{ token: string; until: number }>(
        leaseKey,
        (lease) => (lease?.token === token ? { token, until: 0 } : lease!),
      );
    }
  }
  private async snapshot(doc: OfficialPolicyDocument): Promise<void> {
    const prefix = `snapshot:${doc.id}:`;
    await this.store.update(
      `${prefix}${doc.version}:${doc.contentHash}`,
      () => ({
        id: doc.id,
        url: doc.url,
        title: doc.title,
        version: doc.version,
        contentHash: doc.contentHash,
        fetchedAt: doc.fetchedAt,
        bodyText: doc.bodyText,
      }),
    );
    const rows = await this.store.list<{ version: number }>(prefix);
    for (const row of rows
      .sort((a, b) => b.value.version - a.value.version)
      .slice(20))
      await this.store.remove(row.key);
  }
  async collect(
    signal: AbortSignal = AbortSignal.timeout(300_000),
  ): Promise<void> {
    // Shared public cache: no enterprise profile is sent during collection/extraction.
    const errors: CollectionStatus['errors'] = [];
    const workspaces = await this.store.list<Workspace>('workspace:');
    const analyzeEnabled = workspaces.some(({ value }) => value.enabled);
    const knownDocuments = (
      await this.store.list<OfficialPolicyDocument>('document:')
    ).map(({ value }) => value);
    const priorityIds = new Set(
      (await this.store.list<PolicyDiagnosis>('diagnosis:')).map(
        ({ value }) => value.policyId,
      ),
    );
    for (const source of this.options.sources) {
      if (signal.aborted) break;
      try {
        const failedUrls: string[] = [];
        const documents = await collectPolicySource(
          source,
          this.options.fetchImpl ?? fetch,
          signal,
          this.now(),
          (url) => failedUrls.push(url),
          knownDocuments,
          priorityIds,
        );
        if (failedUrls.length) {
          errors.push({
            sourceId: source.id,
            message: `${source.name}部分条目暂不可用（${failedUrls.length}条），其余政策已保留`,
          });
          for (const {
            key,
            value,
          } of await this.store.list<OfficialPolicyDocument>('document:'))
            if (value.sourceId === source.id && failedUrls.includes(value.url))
              await this.store.update(key, () => ({
                ...value,
                sourceStatus: 'unavailable',
              }));
        }
        for (const doc of documents) {
          const old = await this.store.get<OfficialPolicyDocument>(
            `document:${doc.id}`,
          );
          if (
            old?.contentHash === doc.contentHash &&
            old.interpretationStatus === 'ready' &&
            old.interpretationVersion === POLICY_INTERPRETATION_VERSION
          ) {
            await this.store.update(`document:${doc.id}`, () => ({
              ...old,
              fetchedAt: doc.fetchedAt,
              sourceStatus: 'verified',
            }));
            continue;
          }
          const next = {
            ...doc,
            version:
              old?.contentHash === doc.contentHash
                ? old.version
                : (old?.version ?? 0) + 1,
          };
          if (old && old.contentHash !== doc.contentHash)
            await this.snapshot(old);
          await this.snapshot(next);
          await this.store.update(`document:${doc.id}`, () => next);
          if (analyzeEnabled && !doc.attachments.some((item) => !item.parsed))
            await this.interpret(next, signal);
        }
      } catch {
        if (signal.aborted) break;
        errors.push({ sourceId: source.id, message: `${source.name}暂不可用` });
        for (const {
          key,
          value,
        } of await this.store.list<OfficialPolicyDocument>('document:'))
          if (value.sourceId === source.id)
            await this.store.update(key, () => ({
              ...value,
              sourceStatus: 'unavailable',
            }));
      }
    }
    if (signal.aborted) return;
    await this.store.update('collection:status', () => ({
      at: this.now().toISOString(),
      errors,
    }));
    for (const { value } of workspaces) {
      if (signal.aborted) break;
      if (!value.enabled || !value.enabledBy) continue;
      try {
        const actor = await this.actor(value.enabledBy);
        const current = await this.workspace(actor);
        if (current.enabled) await this.recommend(actor, current, signal);
      } catch {
        // Isolate one tenant's provider/budget failure, but make it visible to that tenant.
        if (signal.aborted) break;
        const currentActor = await this.options.getActor(value.enabledBy);
        if (currentActor)
          await this.store.update<Workspace>(
            orgKey(currentActor),
            (current) => ({
              ...(current ?? blank()),
              analysisError:
                '后台推荐暂未完成，请检查模型配置、分析额度后重试；已有政策原文仍可查看。',
            }),
          );
      }
    }
  }
}
