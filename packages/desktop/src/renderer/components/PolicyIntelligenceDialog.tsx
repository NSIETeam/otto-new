/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  PolicyAction,
  PolicyEnterpriseProfile,
  PolicyIntelligenceState,
} from '../../preload/index.js';
import { DialogFrame } from './WorkspaceDialogs.js';
import {
  emptyPolicyState,
  parsePolicyAnswer,
  policyDisplayStatus,
  policyDisplayValidity,
  policyErrorMessage,
  POLICY_CONCLUSION_LABELS,
  POLICY_LEVEL_LABELS,
  POLICY_STATUS_LABELS,
} from '../policyIntelligencePresentation.js';
import './PolicyIntelligenceDialog.css';
import { PolicyFeedbackForm } from './PolicyFeedbackForm.js';

const PROFILE_FIELDS = [
  ['registeredRegion', '注册所在地', '例如：四川省成都市武侯区'],
  ['industry', '所属行业', '例如：软件与信息技术服务'],
  ['mainBusiness', '主营业务', '说明主要产品、服务和客户'],
  ['enterpriseType', '登记类型', '例如：有限责任公司'],
  ['establishedAt', '成立日期', 'YYYY-MM-DD'],
] as const;

export function PolicyIntelligenceDialog({
  open,
  initialPolicyId,
  scopeId,
  seedProfile,
  onClose,
}: {
  open: boolean;
  initialPolicyId?: string;
  scopeId: string;
  seedProfile: PolicyEnterpriseProfile;
  onClose(): void;
}): React.JSX.Element | null {
  const [state, setState] = useState<PolicyIntelligenceState>(emptyPolicyState);
  const [profile, setProfile] = useState<PolicyEnterpriseProfile>(seedProfile);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [enableConsent, setEnableConsent] = useState(false);
  const [configurationUncertain, setConfigurationUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'evaluate' | 'prepare' | 'all'>('all');
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('all');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<string>();
  const [consentFor, setConsentFor] = useState<string>();
  const [consent, setConsent] = useState(false);
  const [answer, setAnswer] = useState('');
  const [shareAnswer, setShareAnswer] = useState(false);
  const epoch = useRef(0);
  const profileDirty = useRef(false);
  const editProfile = (next: PolicyEnterpriseProfile): void => {
    profileDirty.current = true;
    setProfile(next);
  };
  const seedRef = useRef(seedProfile);
  seedRef.current = seedProfile;
  const request = useCallback(
    async (action?: PolicyAction): Promise<void> => {
      const current = ++epoch.current;
      setLoading(true);
      setError('');
      setNotice('');
      try {
        const result = action
          ? await window.otto.policyIntelligenceAction({ scopeId, action })
          : await window.otto.policyIntelligenceGet(scopeId);
        if (current !== epoch.current) return;
        setState(result);
        setLoaded(true);
        setConfigurationUncertain(false);
        if (action?.action === 'configure') setEnableConsent(false);
        if (!profileDirty.current || action?.action === 'profile') {
          setProfile({ ...seedRef.current, ...result.profile });
          profileDirty.current = false;
        }
        if (action) {
        setAnswer('');
        setShareAnswer(false);
        setConsentFor(undefined);
        setConsent(false);
        }
      } catch (cause) {
        if (current !== epoch.current) return;
        setError(policyErrorMessage(cause));
        if (action?.action === 'configure') {
          setConfigurationUncertain(true);
          // A gateway failure is not proof that the write failed. Reconcile
          // with a read only; never automatically submit the mutation twice.
          try {
            const confirmed = await window.otto.policyIntelligenceGet(scopeId);
            if (current !== epoch.current) return;
            setState(confirmed);
            setLoaded(true);
            setConfigurationUncertain(false);
            setEnableConsent(false);
            if (confirmed.enabled === action.enabled) {
              setError('');
              setNotice(`已重新核对：个性化服务现已${confirmed.enabled ? '开启' : '关闭'}。`);
            }
          } catch { /* Preserve the unknown outcome and require a read first. */ }
        }
      } finally {
        if (current === epoch.current) setLoading(false);
      }
    },
    [scopeId],
  );
  useEffect(() => {
    setState(emptyPolicyState());
    setLoaded(false);
    setConfigurationUncertain(false);
    setEnableConsent(false);
    setProfile(seedRef.current);
    setSelected(undefined);
    setConsentFor(undefined);
    setConsent(false);
    setAnswer('');
    setShareAnswer(false);
    profileDirty.current = false;
  }, [scopeId]);
  useEffect(() => {
    if (open) void request();
    // The epoch is a request generation, not a DOM ref; cleanup invalidates all pending responses.
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
    };
  }, [open, request]);
  useEffect(() => {
    if (open && initialPolicyId) {
      setSelected(initialPolicyId);
      setQuery('');
      setLevel('all');
      setCategory('all');
      setStatus('all');
      setTab('all');
    }
  }, [open, initialPolicyId]);
  const assessmentById = useMemo(
    () => new Map(state.assessments.map((item) => [item.policyId, item])),
    [state.assessments],
  );
  useEffect(() => {
    if (open && selected)
      document
        .getElementById(`otto-policy-${selected}`)
        ?.scrollIntoView?.({ block: 'start' });
  }, [open, selected, state.policies.length]);
  const policies = state.policies.filter(
    (doc) =>
      (tab === 'all' ||
        (state.enabled && assessmentById.get(doc.id)?.group === tab)) &&
      (level === 'all' || doc.level === level) &&
      (category === 'all' || doc.categories.includes(category)) &&
      (status === 'all' || policyDisplayStatus(doc) === status) &&
      (!query.trim() ||
        [doc.title, doc.summary, ...doc.categories]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  const currentDiagnosis = state.diagnoses.find(
    (item) => item.policyId === selected,
  );
  const staleLatestDiagnoses = state.diagnoses.filter(
    (item, index, all) =>
      item.stale &&
      all.findIndex((entry) => entry.policyId === item.policyId) === index,
  );
  const submitAnswer = (unknown = false): void => {
    if (!currentDiagnosis?.question) return;
    try {
      const value = unknown
        ? null
        : parsePolicyAnswer(
            currentDiagnosis.question.field,
            answer,
            currentDiagnosis.question.valueType,
          );
      void request({
        action: 'answer',
        diagnosisId: currentDiagnosis.id,
        revision: currentDiagnosis.revision,
        field: currentDiagnosis.question.field,
        value,
        saveToEnterprise: !unknown && shareAnswer,
        consent: !unknown && shareAnswer,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  if (!open) return null;
  return (
    <DialogFrame title="政策智能服务" onClose={() => {
      if (profileDirty.current && !window.confirm('企业资料尚未保存，确定放弃修改并关闭吗？')) return;
      if (profileDirty.current) { setProfile({ ...seedRef.current, ...state.profile }); profileDirty.current = false; }
      onClose();
    }}>
      <div className="otto-policy-v2">
        <section className="otto-policy-v2__hero">
          <div>
            <span className="otto-policy-v2__eyebrow">
              面向所有企业 · 官方政策来源
            </span>
            <h3>找到企业能用的政策，弄清还差什么。</h3>
            <p>
              按企业注册所在地关联区县、市、省及国家级政策。也可以直接在对话中说“有哪些适合我们公司的政策”。
            </p>
          </div>
          <div className="otto-policy-v2__service-control">
          {loaded && state.canManage && !state.enabled && (
            <label className="otto-policy-v2__check">
              <input type="checkbox" checked={enableConsent} disabled={loading || configurationUncertain} onChange={(event) => setEnableConsent(event.target.checked)} />
              我同意使用企业基础资料进行模型分析，可随时关闭；分析会消耗模型额度。
            </label>
          )}
          <button
            type="button"
            disabled={loading || !loaded || !state.canManage || configurationUncertain || (!state.enabled && !enableConsent)}
            onClick={() =>
              void request({ action: 'configure', enabled: !state.enabled, ...(!state.enabled ? {consent: true} : {}) })
            }
          >
            {state.enabled ? '关闭个性化服务' : '开启个性化服务'}
          </button>
          </div>
        </section>
        <p className="otto-policy-v2__muted">
          {!loaded ? '尚未取得服务状态，请等待加载或刷新重试。' : state.enabled
            ? '个性化服务已开启。公共政策由服务端定时更新，未变化的分析结果复用。'
            : '个性化服务未开启：仍可查看已收录的公共政策，不发起本企业的模型分析。'}
          {loaded && !state.canManage ? ' 企业管理员可以开启、完善资料和发起诊断。' : ''}
        </p>
        <div
          className="otto-policy-v2__coverage"
          aria-label="所在地政策来源覆盖"
        >
          {state.coverage.map((item) => (
            <span
              key={item.level}
              className={item.status === 'missing' ? 'is-missing' : ''}
            >
              {item.regionLabel} ·{' '}
              {item.sourceCount
                ? item.sourceCount + ' 个已配置来源'
                : '尚未接入'}
            </span>
          ))}
        </div>
        <p className="otto-policy-v2__muted">
          已配置来源不代表该地区政策已全部收录；未接入地区不会误用其他城市政策。
        </p>
        <details
          className="otto-policy-v2__profile"
          open={state.missingProfileFields.length > 0}
        >
          <summary>
            企业资料{' '}
            {state.missingProfileFields.length
              ? '· 还需补充 ' + state.missingProfileFields.length + ' 项'
              : '· 查看或修改'}
          </summary>
          <p>
            基础资料用于共享推荐；营收、研发费用等在具体诊断中按需询问，默认仅本账号保存。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void request({ action: 'profile', profile, consent: true });
            }}
          >
            <label>
              企业名称
              <input
                disabled={!state.canManage}
                value={profile.organizationName ?? ''}
                onChange={(event) =>
                  editProfile({
                    ...profile,
                    organizationName: event.target.value,
                  })
                }
              />
            </label>
            {PROFILE_FIELDS.map(([key, label, placeholder]) => (
              <label key={key}>
                {label}
                <input
                  disabled={!state.canManage}
                  value={profile[key] ?? ''}
                  placeholder={placeholder}
                  onChange={(event) =>
                    editProfile({ ...profile, [key]: event.target.value })
                  }
                />
              </label>
            ))}
            <label className="is-wide">
              已有资质
              <input
                disabled={!state.canManage}
                placeholder="没有请填“暂无”；不清楚请填“不确定”"
                value={profile.qualifications?.join('、') ?? ''}
                onChange={(event) =>
                  editProfile({
                    ...profile,
                    qualifications: event.target.value
                      .split(/[、，,]/u)
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            {state.canManage && (
              <button disabled={loading} type="submit">
                保存为企业共享资料
              </button>
            )}
          </form>
        </details>
        <div className="otto-policy-v2__toolbar">
          <div role="tablist" aria-label="政策列表">
            {(
              [
                ['evaluate', '值得评估'],
                ['prepare', '提前准备'],
                ['all', '全部政策'],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void request()}
          >
            刷新列表
          </button>
          {state.canManage && (
            <button
              type="button"
              disabled={loading || !state.enabled}
              onClick={() => void request({ action: 'sync' })}
            >
              更新企业推荐
            </button>
          )}
        </div>
        <div className="otto-policy-v2__filters">
          <input
            aria-label="搜索政策"
            placeholder="搜索政策名称、内容或类型"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            aria-label="政策级别"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
          >
            <option value="all">全部级别</option>
            {Object.entries(POLICY_LEVEL_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="政策类型"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">全部类型</option>
            {state.categories.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <select
            aria-label="申报状态"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">全部状态</option>
            {Object.entries(POLICY_STATUS_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <p className="otto-policy-v2__muted">
          {loading ? '正在处理，请稍候…' : loaded ? policies.length + ' 条政策' : '政策列表未加载'} ·{' '}
          {state.lastSyncAt
            ? '来源最近更新 ' +
              new Date(state.lastSyncAt).toLocaleString('zh-CN')
            : '等待服务端首次采集'}{' '}
          · 模型：{state.modelName || '未配置'} · 今日已分析{' '}
          {state.usedAnalysesToday}/{state.dailyAnalysisLimit} 次
        </p>
        {(error || state.lastError) && (
          <p role="alert" className="otto-policy-v2__error">
            {error || policyErrorMessage(state.lastError)}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {(error || configurationUncertain) && (
          <button type="button" disabled={loading} onClick={() => void request()}>重新读取状态</button>
        )}
        {configurationUncertain && <p role="status">开关结果尚未确认，重新读取状态后再操作。</p>}
        {staleLatestDiagnoses.length > 0 && (
          <section className="otto-policy-v2__warning" role="status">
            <strong>已准备的政策有变化，需要重新核验</strong>
            <p>
              原文、规则、企业资料或申报期限已变化。旧诊断仍保留供回看，不再作为当前申报依据。
            </p>
            {staleLatestDiagnoses.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={
                  !state.policies.some((doc) => doc.id === item.policyId)
                }
                onClick={() => {
                  setTab('all');
                  setLevel('all');
                  setCategory('all');
                  setStatus('all');
                  setQuery('');
                  setSelected(item.policyId);
                }}
              >
                查看：
                {state.policies.find((doc) => doc.id === item.policyId)
                  ?.title ?? '已不在当前所在地范围的历史政策'}
              </button>
            ))}
          </section>
        )}
        {consentFor && (
          <section className="otto-policy-v2__consent">
            <h4>开始本次政策诊断</h4>
            <p>
              模型仅读取基础资料及本政策实际需要的补充字段，逐项分析申报条件。补充回答默认私有，不会发送完整企业档案、替你提交申请或联系机构。
            </p>
            <label>
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              我同意以上数据用途和模型分析
            </label>
            <div>
              <button
                disabled={!consent || loading}
                type="button"
                onClick={() =>
                  void request(
                    {
                          action: 'diagnose',
                          policyId: consentFor,
                          consent: true,
                        },
                  )
                }
              >
                同意并开始诊断
              </button>
              <button type="button" onClick={() => setConsentFor(undefined)}>
                取消
              </button>
            </div>
          </section>
        )}
        <div className="otto-policy-v2__list">
          {policies.map((doc) => {
            const expanded = selected === doc.id;
            const diagnosis = expanded ? currentDiagnosis : undefined;
            const latest =
              state.diagnoses.find(
                (item) => item.policyId === doc.id && !item.stale,
              ) ?? assessmentById.get(doc.id);
            const unavailable =
              doc.sourceStatus !== 'verified' ||
              doc.interpretationStatus !== 'ready' ||
              doc.attachments.some((item) => !item.parsed);
            return (
              <article key={doc.id} id={`otto-policy-${doc.id}`}>
                <div className="otto-policy-v2__tags">
                  <span>{POLICY_LEVEL_LABELS[doc.level]}</span>
                  {doc.categories.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                  <span>{POLICY_STATUS_LABELS[policyDisplayStatus(doc)]}</span>
                  {latest && (
                    <span className={'is-' + latest.status}>
                      {POLICY_CONCLUSION_LABELS[latest.status]}
                    </span>
                  )}
                </div>
                <h3>{doc.title}</h3>
                <p>
                  {doc.summary ||
                    '正文已收录，结构化解读待完成。请先查看官方原文。'}
                </p>
                <p className="otto-policy-v2__muted">
                  {doc.sourceName} ·{' '}
                  {doc.batch?.year &&
                    `${doc.batch.year}年 ${doc.batch.label ?? ''} · `}
                  {doc.deadline ? '截止 ' + doc.deadline : '申报时间尚未核验'} ·
                  第 {doc.version} 版
                </p>
                {unavailable && (
                  <p className="otto-policy-v2__warning">
                    原文、附件或结构化条件尚未完成核验，暂不生成资格结论。
                  </p>
                )}
                <footer>
                  {
                    <button
                      type="button"
                      disabled={
                        loading ||
                        !state.enabled ||
                        state.notificationCapability !== true
                      }
                      title={
                        state.notificationCapability !== true
                          ? '企业服务器升级后可启用政策提醒'
                          : '提醒进入我的消息，不自动提交申报'
                      }
                      onClick={() =>
                        void request({
                          action: 'watch',
                          policyId: doc.id,
                          enabled: !state.watchedPolicyIds?.includes(doc.id),
                        })
                      }
                    >
                      {state.watchedPolicyIds?.includes(doc.id)
                        ? '取消政策提醒'
                        : '关注截止与变更'}
                    </button>
                  }
                  <button
                    type="button"
                    onClick={() => setSelected(expanded ? undefined : doc.id)}
                  >
                    {expanded ? '收起详情' : '条件与材料'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.otto.openExternal(doc.url)}
                  >
                    查看官方原文
                  </button>
                  {state.canManage && (
                    <button
                      type="button"
                      disabled={
                        loading ||
                        !state.enabled ||
                        unavailable ||
                        !['open', 'upcoming', 'evergreen'].includes(
                          policyDisplayStatus(doc),
                        )
                      }
                      onClick={() => {
                        setSelected(doc.id);
                        setConsentFor(doc.id);
                        setConsent(false);
                      }}
                    >
                      诊断能否申报
                    </button>
                  )}
                </footer>
                {expanded && (
                  <div className="otto-policy-v2__detail">
                    <p className="otto-policy-v2__muted">
                      {policyDisplayValidity(doc)} · 申报窗口：
                      {POLICY_STATUS_LABELS[policyDisplayStatus(doc)]}
                    </p>
                    {doc.governance && (
                      <section className="otto-policy-v2__warning">
                        <strong>已收录的效力变更依据</strong>
                        <blockquote>{doc.governance.quote}</blockquote>
                        <button
                          type="button"
                          onClick={() =>
                            void window.otto.openExternal(
                              doc.governance!.referenceUrl,
                            )
                          }
                        >
                          查看效力依据
                        </button>
                      </section>
                    )}
                    <h4>支持内容</h4>
                    <p>{doc.supportText || '请以原文为准'}</p>
                    {latest?.supportEstimate && (
                      <section className="otto-policy-v2__condition">
                        <strong>
                          {latest.supportEstimate.amountCny === undefined
                            ? '暂不估算金额'
                            : `按原文估算 ${latest.supportEstimate.amountCny.toLocaleString('zh-CN')} 元`}
                        </strong>
                        <p>{latest.supportEstimate.explanation}</p>
                        <blockquote>{latest.supportEstimate.quote}</blockquote>
                      </section>
                    )}
                    <h4>排除条款与例外</h4>
                    {(doc.exclusions ?? []).map((exclusion) => {
                      const judgment = latest?.exclusions?.find(
                        (item) => item.id === exclusion.id,
                      );
                      return (
                        <section
                          key={exclusion.id}
                          className={
                            'otto-policy-v2__condition is-' +
                            (judgment?.result === 'hit'
                              ? 'gap'
                              : judgment?.result === 'clear'
                                ? 'met'
                                : 'unknown')
                          }
                        >
                          <strong>
                            {judgment
                              ? {
                                  hit: '已命中',
                                  clear: '未命中／例外已满足',
                                  unknown: '待核实，不直接判不符合',
                                }[judgment.result]
                              : '尚未核验企业事实'}{' '}
                            · {exclusion.label}
                          </strong>
                          <blockquote>{exclusion.quote}</blockquote>
                          <small>
                            {exclusion.scopeConditionIds?.length
                              ? '仅约束指定申报路径，不作全局否决。'
                              : '约束本批次整体资格。'}
                            {exclusion.unless
                              ? ' 存在例外，必须一起核验。'
                              : ''}
                            {exclusion.appliesWhen
                              ? ' 仅在符合适用范围时生效。'
                              : ''}
                          </small>
                        </section>
                      );
                    })}
                    {!doc.exclusions?.length && (
                      <p>
                        {doc.exclusionsReviewed
                          ? '当前已核验原文未提取到独立排除条款，仍须满足下列申报条件。'
                          : '排除条款尚未完成核验，不据此认定没有限制。'}
                      </p>
                    )}
                    <h4>申报条件</h4>
                    {doc.conditions.map((condition) => {
                      const judgment =
                        diagnosis && !diagnosis.stale
                          ? diagnosis.conditions.find(
                              (item) => item.id === condition.id,
                            )
                          : undefined;
                      return (
                        <section
                          key={condition.id}
                          className={
                            'otto-policy-v2__condition is-' +
                            (judgment?.result ?? 'unknown')
                          }
                        >
                          <strong>
                            {judgment
                              ? {
                                  met: '已有资料支持',
                                  gap: '存在差距',
                                  unknown: '待确认',
                                }[judgment.result]
                              : '原文条件'}{' '}
                            · {condition.label}
                          </strong>
                          <blockquote>{condition.quote}</blockquote>
                          {judgment && <p>{judgment.evidence}</p>}
                        </section>
                      );
                    })}
                    {!doc.conditions.length && <p>尚无已核验的结构化条件。</p>}
                    {diagnosis && (
                      <section className="otto-policy-v2__diagnosis">
                        <h4>本账号诊断</h4>
                        <p>
                          {diagnosis.stale
                            ? '政策或企业资料已变化，旧结果仅供回看，请重新诊断。'
                            : diagnosis.summary}
                        </p>
                        {!diagnosis.stale &&
                          diagnosis.warnings?.map((warning) => (
                            <p
                              key={warning}
                              className="otto-policy-v2__warning"
                            >
                              {warning}
                            </p>
                          ))}
                        {!diagnosis.stale && diagnosis.question && (
                          <div>
                            <label>
                              {diagnosis.question.label}
                              <input
                                value={answer}
                                onChange={(event) =>
                                  setAnswer(event.target.value)
                                }
                              />
                            </label>
                            <label className="otto-policy-v2__check">
                              <input
                                type="checkbox"
                                checked={shareAnswer}
                                onChange={(event) =>
                                  setShareAnswer(event.target.checked)
                                }
                              />
                              同时保存为企业共享资料（需确定信息）
                            </label>
                            <div>
                              <button
                                type="button"
                                disabled={loading}
                                onClick={() => submitAnswer()}
                              >
                                继续诊断
                              </button>
                              <button
                                type="button"
                                disabled={loading}
                                onClick={() => submitAnswer(true)}
                              >
                                不确定，先跳过
                              </button>
                            </div>
                          </div>
                        )}
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() =>
                            void request({
                              action: 'delete-diagnosis',
                              diagnosisId: diagnosis.id,
                            })
                          }
                        >
                          删除本次诊断
                        </button>
                      </section>
                    )}
                    <h4>材料准备</h4>
                    {doc.materials.map((material) => {
                      const record =
                        state.materials[doc.id + ':' + material.id];
                      const value =
                        record?.version === doc.contentHash
                          ? record.status
                          : 'unknown';
                      return (
                        <label
                          className="otto-policy-v2__material"
                          key={material.id}
                        >
                          <span>
                            {material.label}
                            <small>{material.quote}</small>
                          </span>
                          <select
                            aria-label={material.label + '准备状态'}
                            disabled={!state.canManage || loading}
                            value={value}
                            onChange={(event) =>
                              void request({
                                action: 'material',
                                policyId: doc.id,
                                materialId: material.id,
                                materialStatus: event.target.value as
                                  'ready' | 'unknown' | 'missing',
                              })
                            }
                          >
                            <option value="unknown">待确认</option>
                            <option value="ready">已准备</option>
                            <option value="missing">尚缺少</option>
                          </select>
                        </label>
                      );
                    })}
                    {!doc.materials.length && (
                      <p>材料清单尚未核验，请查看原文附件。</p>
                    )}
                    {state.canManage && (
                      <PolicyFeedbackForm
                        key={`${scopeId}:${doc.id}:${state.feedbackRevisions?.[doc.id] ?? 0}`}
                        policyId={doc.id}
                        record={state.feedback?.find(
                          (item) => item.policyId === doc.id,
                        )}
                        revision={state.feedbackRevisions?.[doc.id] ?? 0}
                        loading={loading}
                        submit={request}
                      />
                    )}
                    <h4>官方资源与对接</h4>
                    {doc.resources.length ? (
                      doc.resources.map((resource) => (
                        <p key={resource.url}>
                          <button
                            type="button"
                            onClick={() =>
                              void window.otto.openExternal(resource.url)
                            }
                          >
                            {resource.label}
                          </button>
                          <small>{resource.quote}</small>
                        </p>
                      ))
                    ) : (
                      <p>
                        尚无已核验的对接链接。请从政策原文查找主管部门和申报入口。
                      </p>
                    )}
                    {doc.attachments.map((attachment) => (
                      <div key={attachment.url}>
                        <button
                          type="button"
                          disabled={!attachment.url.startsWith('https://')}
                          onClick={() =>
                            void window.otto.openExternal(attachment.url)
                          }
                        >
                          {attachment.label}
                        </button>{' '}
                        · {attachment.parsed ? '已解析' : '待核验附件'}
                        {attachment.reason && (
                          <small>{attachment.reason}</small>
                        )}
                        {!!attachment.sections?.length && (
                          <details>
                            <summary>
                              附件依据（{attachment.sections.length} 处）
                            </summary>
                            {attachment.sections.map((section, i) => (
                              <blockquote key={i}>
                                <strong>{section.locator}</strong>
                                <p>{section.text}</p>
                              </blockquote>
                            ))}
                          </details>
                        )}
                      </div>
                    ))}
                    {!!doc.relatedBatches?.length && (
                      <section>
                        <h4>原文关联与历年批次</h4>
                        <p>
                          关联仅供查阅，往年条件、材料和期限不沿用到当前批次。
                        </p>
                        {doc.relatedBatches.map((batch) => (
                          <p key={batch.policyId}>
                            <button
                              type="button"
                              onClick={() => {
                                setQuery('');
                                setLevel('all');
                                setCategory('all');
                                setStatus('all');
                                setTab('all');
                                setSelected(batch.policyId);
                              }}
                            >
                              {batch.title}
                            </button>
                            <small>{batch.reason}</small>
                            <button
                              type="button"
                              onClick={() =>
                                void window.otto.openExternal(batch.evidenceUrl)
                              }
                            >
                              查看关联依据
                            </button>
                          </p>
                        ))}
                      </section>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {!loading && !policies.length && (
            <div className="otto-policy-v2__empty">
              <h4>
                {!loaded ? '暂时无法加载政策' : tab === 'all'
                  ? '当前筛选条件下暂无已收录政策'
                  : '还没有这类企业推荐'}
              </h4>
              <p>
                {!loaded ? '未取得服务器数据，不能据此判断有没有政策。请使用“重新读取状态”。'
                  : state.policies.length === 0
                  ? '公共政策库暂无可展示内容。请检查所在地资料和页面底部的来源采集情况；未收录不代表当地没有政策。'
                  : tab === 'all'
                  ? '已有政策，但没有符合当前筛选的条目；可以清除筛选条件。'
                  : !state.enabled
                  ? '个性化服务尚未开启；公共政策仍在“全部政策”中，不会因关闭而删除。'
                  : '尚无这类推荐。请完善企业资料并更新推荐，也可先查看全部政策原文。'}
              </p>
              {loaded && state.policies.length > 0 && (
                <button type="button" onClick={() => { setTab('all'); setQuery(''); setLevel('all'); setCategory('all'); setStatus('all'); }}>查看全部政策</button>
              )}
            </div>
          )}
        </div>
        <p className="otto-policy-v2__notice">
          分析仅辅助准备和人工决策，不保证获批。申报资格、具体批次、材料与期限以主管部门最新原文为准。
        </p>
        {!!state.sourceHealth?.length && (
          <details className="otto-policy-v2__sources">
            <summary>全国官方来源接入情况</summary>
            <p>包含中国内地31个省级政府入口；市县和部门并非全量覆盖。数字为最近一次采集条目数，不代表当地政策总数。</p>
            <div className="otto-policy-v2__sources-scroll" role="region" aria-label="全国官方来源列表" tabIndex={0}>
              {state.sourceHealth.map((source) => (
                <p key={source.sourceId}>
                  <button type="button" onClick={() => void window.otto.openExternal(source.url)}>{source.name}</button>
                  {' · '}{({unverified:'尚未完成采集核验',available:'最近采集成功',partial:'部分条目失败',unavailable:'暂不可采集，需检查适配'})[source.status]}{' · '}{source.documentCount} 条
                  {source.checkedAt && <small>最近检查：{new Date(source.checkedAt).toLocaleString('zh-CN')}</small>}
                </p>
              ))}
            </div>
          </details>
        )}
      </div>
    </DialogFrame>
  );
}
