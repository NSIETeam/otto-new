/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 企业记忆、专家、自动 Skill 与 Skill 专区的确定性对话入口。
 * 普通查询和路由不调用模型；组织写入和 Skill 安装/拒绝必须强确认。
 */

export interface ConversationalKnowledgeItem {
  id: string;
  title?: string;
  category: string;
  content: string;
  confidence: number;
  status?: 'pending_review' | 'active' | 'archived';
  sourceLabel?: string | null;
  expiresAt?: string | null;
  reviewDueAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface ConversationalExpert {
  id: string;
  label: string;
  profileId: string;
  customAgentId?: string;
  available: boolean;
}

export interface ConversationalAutoSkillCandidate {
  id: string;
  name: string;
  description: string;
  detectedPattern: string;
  occurrenceCount: number;
  recommendation?: 'create' | 'enhance';
  draft?: {
    validationPassed: boolean;
    packageReady: boolean;
    validationErrors: string[];
    validationWarnings: string[];
    tests: Array<{ name: string; status: 'passed' | 'failed' | 'needs-review'; detail: string }>;
    risk: {
      permissions: string[];
      fileChanges: string[];
      securityRisks: string[];
      executionBlocked: boolean;
    };
  };
}

interface KnowledgeDraft {
  kind: 'knowledge';
  sourceId: string;
  title: string;
  category: string;
  content: string;
  phase: 'collecting' | 'ready' | 'failed';
}

interface AutoSkillDraft {
  kind: 'auto_skill';
  candidateId: string;
  candidateName: string;
  action: 'install' | 'reject';
}

type CapabilityDraft = KnowledgeDraft | AutoSkillDraft;

interface StoredDraft {
  draft: CapabilityDraft;
  expiresAt: number;
  touchedAt: number;
}

const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_DRAFTS = 5_000;
const MAX_MESSAGE_TEXT = 4_000;
const MAX_KNOWLEDGE_RESULTS = 5;
const MAX_KNOWLEDGE_CONTENT = 700;
const MAX_SKILL_RESULTS = 5;

function boundedText(value: unknown, max = MAX_MESSAGE_TEXT): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function draftKey(accountId: string, sessionId: string): string {
  return `${accountId}\u0000${sessionId}`;
}

export class WorkspaceCapabilityDraftRegistry {
  private readonly drafts = new Map<string, StoredDraft>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  get(accountId: string, sessionId: string): CapabilityDraft | null {
    const key = draftKey(accountId, sessionId);
    const stored = this.drafts.get(key);
    if (!stored) return null;
    if (stored.expiresAt <= this.now()) {
      this.drafts.delete(key);
      return null;
    }
    stored.touchedAt = this.now();
    stored.expiresAt = stored.touchedAt + DRAFT_TTL_MS;
    return stored.draft;
  }

  set(accountId: string, sessionId: string, draft: CapabilityDraft): void {
    const now = this.now();
    this.drafts.set(draftKey(accountId, sessionId), {
      draft,
      touchedAt: now,
      expiresAt: now + DRAFT_TTL_MS,
    });
    this.enforceCapacity();
  }

  delete(accountId: string, sessionId: string): void {
    this.drafts.delete(draftKey(accountId, sessionId));
  }

  claim(accountId: string, sessionId: string): boolean {
    const key = draftKey(accountId, sessionId);
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  release(accountId: string, sessionId: string): void {
    this.inFlight.delete(draftKey(accountId, sessionId));
  }

  isClaimed(accountId: string, sessionId: string): boolean {
    return this.inFlight.has(draftKey(accountId, sessionId));
  }

  size(): number {
    return this.drafts.size;
  }

  private enforceCapacity(): void {
    if (this.drafts.size <= MAX_DRAFTS) return;
    const ordered = [...this.drafts.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    for (const [key] of ordered.slice(0, this.drafts.size - MAX_DRAFTS)) this.drafts.delete(key);
  }
}

export interface WorkspaceCapabilityConversationInput {
  text: string;
  accountId: string;
  sessionId: string;
  enterpriseMemoryEnabled: boolean;
  role: string | null;
  experts: readonly ConversationalExpert[];
  autoSkillCandidates: readonly ConversationalAutoSkillCandidate[];
  registry: WorkspaceCapabilityDraftRegistry;
  listKnowledge(input: { query?: string }): Promise<ConversationalKnowledgeItem[]>;
  recordKnowledge(input: {
    sourceId: string;
    title: string;
    category: string;
    content: string;
    confidence: number;
    sourceType: 'manual';
    sourceLabel: string;
  }): Promise<{ status: string; added: boolean }>;
  launchExpert(expert: ConversationalExpert, task: string): boolean | Promise<boolean>;
  selectExpert(expert: ConversationalExpert): void;
  openSkillZone(): void;
  confirmAutoSkill(candidateId: string): void | Promise<void>;
  rejectAutoSkill(candidateId: string): void | Promise<void>;
  postMessage(role: 'user' | 'assistant', text: string): void;
}

function isIntroOrNegative(text: string): boolean {
  return /(?:是什么|什么意思|怎么用|如何使用)/u.test(text)
    || /^(?:请)?(?:介绍|解释).{0,20}(?:企业知识|企业记忆|自动\s*Skill|Skill\s*专区|专家)/iu.test(text)
    || /(?:不想|不要|不用|别|无需|不需要).{0,8}(?:查|看|打开|进入|启动|调用|安装|拒绝|记入|写入|录入)/u.test(text);
}

function isCancellation(text: string): boolean {
  return /^(?:取消|放弃|不用了|不做了|取消操作)[。！!\s]*$/u.test(text.trim());
}

function postHandled(
  input: WorkspaceCapabilityConversationInput,
  userText: string,
  assistantText: string,
): void {
  input.postMessage('user', userText);
  input.postMessage('assistant', assistantText);
}

function memoryQueryIntent(text: string): boolean {
  return /(?:企业知识|企业记忆|公司知识|公司制度).{0,12}(?:查|查询|搜索|找|查看|有哪些|列出)/u.test(text)
    || /(?:查|查询|搜索|找|查看|列出).{0,12}(?:企业知识|企业记忆|公司知识|公司制度)/u.test(text)
    || /(?:企业知识|企业记忆)(?:里|中)(?:查|查询|搜索|找|查看)/u.test(text);
}

function extractMemoryQuery(text: string): string {
  return text
    .replace(/^.*?(?:企业知识|企业记忆|公司知识|公司制度)(?:库)?(?:里|中)?(?:查|查询|搜索|找|查看|有哪些|列出)?/u, '')
    .replace(/^(?:请\s+|帮我|一下|相关的|关于)\s*/u, '')
    .replace(/[？?。！!]+$/u, '')
    .trim()
    .slice(0, 200);
}

function knowledgeWriteIntent(text: string): boolean {
  return /(?:新增|添加|记录|写入|录入|记入|存入).{0,8}(?:企业知识|企业记忆)/u.test(text)
    || /把.{2,}(?:记入|写入|录入|存入)(?:企业知识|企业记忆)/u.test(text);
}

function parseLabeledValue(text: string, label: string): string {
  const match = text.match(new RegExp(`(?:^|[；;\\n])\\s*${label}\\s*[：:]\\s*([^；;\\n]+)`, 'u'));
  return boundedText(match?.[1]);
}

function initialKnowledgeContent(text: string): string {
  const ba = text.match(/把([\s\S]{2,2000}?)(?:记入|写入|录入|存入)(?:企业知识|企业记忆)/u);
  if (ba?.[1]) return boundedText(ba[1], 2_000);
  const labeled = parseLabeledValue(text, '内容');
  if (labeled) return boundedText(labeled, 2_000);
  const colon = text.match(/(?:企业知识|企业记忆)\s*[：:]\s*([\s\S]+)/u);
  return boundedText(colon?.[1], 2_000);
}

function knowledgeSummary(draft: KnowledgeDraft): string {
  return [
    '企业知识草稿：',
    `- 标题：${draft.title}`,
    `- 分类：${draft.category}`,
    `- 内容：${draft.content}`,
    '',
    '发布后会影响企业成员后续检索。确认无误请单独回复“确认发布企业知识”。',
  ].join('\n');
}

function updateKnowledgeDraft(draft: KnowledgeDraft, text: string): void {
  const title = parseLabeledValue(text, '标题');
  const category = parseLabeledValue(text, '分类');
  const content = parseLabeledValue(text, '内容');
  if (title) draft.title = title.slice(0, 120);
  if (category) draft.category = category.slice(0, 80);
  if (content) draft.content = content.slice(0, 2_000);
  if (!title && !category && !content) {
    if (!draft.content) draft.content = boundedText(text, 2_000);
    else if (!draft.title) draft.title = boundedText(text, 120);
  }
  draft.phase = draft.title && draft.content ? 'ready' : 'collecting';
}

function missingKnowledgePrompt(draft: KnowledgeDraft): string {
  if (!draft.content) return '请补充要写入的企业知识内容。';
  if (!draft.title) return '已记录知识内容，请补充知识标题。分类默认使用“企业知识”；也可以回复“标题：…；分类：…”。';
  return knowledgeSummary(draft);
}

function formatKnowledgeResults(items: readonly ConversationalKnowledgeItem[], now = Date.now()): string {
  const valid = items.filter((item) => {
    if (item.status && item.status !== 'active') return false;
    const expiresAt = Date.parse(item.expiresAt || '');
    return !Number.isFinite(expiresAt) || expiresAt > now;
  }).slice(0, MAX_KNOWLEDGE_RESULTS);
  if (!valid.length) return '没有找到当前已发布且仍有效的企业知识。你也可以打开右侧“企业记忆”查看待审核、历史版本和证据。';
  return [
    `找到 ${valid.length} 条当前有效的企业知识：`,
    ...valid.map((item, index) => {
      const reviewDue = Date.parse(item.reviewDueAt || '');
      const lifecycle = Number.isFinite(reviewDue) && reviewDue <= now ? ' · 待复核' : '';
      const source = item.sourceLabel ? ` · 来源：${boundedText(item.sourceLabel, 120)}` : '';
      return `${index + 1}. ${boundedText(item.title || item.category, 120)}【${boundedText(item.category, 80)}】\n${boundedText(item.content, MAX_KNOWLEDGE_CONTENT)}\n置信度 ${Math.round(item.confidence * 100)}%${lifecycle}${source}`;
    }),
  ].join('\n\n');
}

function expertListIntent(text: string): boolean {
  return /(?:有哪些|列出|查看|看看|显示).{0,6}(?:专家|我的专家)/u.test(text)
    || /(?:专家|我的专家).{0,6}(?:有哪些|列表)/u.test(text);
}

function expertInvocation(text: string, experts: readonly ConversationalExpert[]): ConversationalExpert[] {
  if (!/(?:用|让|请|交给|调用|启动|打开|选择)/u.test(text)) return [];
  return experts.filter((expert) => expert.available && text.includes(expert.label));
}

function expertTask(text: string, expert: ConversationalExpert): string {
  const position = text.indexOf(expert.label);
  if (position < 0) return '';
  return text.slice(position + expert.label.length)
    .replace(/^[\s，,。；;：:]*(?:帮我|替我|来|去)?[\s，,。；;：:]*/u, '')
    .replace(/[。！!]+$/u, '')
    .trim()
    .slice(0, MAX_MESSAGE_TEXT);
}

function autoSkillQueryIntent(text: string): boolean {
  return /(?:查看|看看|列出|有哪些|显示).{0,8}(?:自动\s*Skill|Skill\s*草稿|Skill\s*候选)/iu.test(text)
    || /(?:自动\s*Skill|Skill\s*草稿|Skill\s*候选).{0,8}(?:查看|有哪些|列表)/iu.test(text);
}

function formatAutoSkills(candidates: readonly ConversationalAutoSkillCandidate[]): string {
  if (!candidates.length) return '当前没有自动 Skill 草稿或候选。可以打开右侧“自动 Skill”执行一次扫描。';
  return [
    `当前有 ${candidates.length} 个自动 Skill 候选，展示前 ${Math.min(candidates.length, MAX_SKILL_RESULTS)} 个：`,
    ...candidates.slice(0, MAX_SKILL_RESULTS).map((candidate, index) => {
      const ready = candidate.draft?.validationPassed === true && candidate.draft.packageReady === true;
      const riskCount = (candidate.draft?.risk.securityRisks.length ?? 0)
        + (candidate.draft?.risk.permissions.length ?? 0);
      return `${index + 1}. ${boundedText(candidate.name, 120)}：${boundedText(candidate.description, 240)}\n${ready ? '检查通过，等待确认' : '检查未通过，禁止安装'} · 风险/权限项 ${riskCount}`;
    }),
  ].join('\n\n');
}

function findAutoSkillCandidate(
  text: string,
  candidates: readonly ConversationalAutoSkillCandidate[],
): ConversationalAutoSkillCandidate | null {
  return [...candidates]
    .sort((left, right) => right.name.length - left.name.length)
    .find((candidate) => text.includes(candidate.name)) ?? null;
}

function autoSkillSummary(candidate: ConversationalAutoSkillCandidate, action: 'install' | 'reject'): string {
  if (action === 'reject') {
    return `将拒绝自动 Skill 候选“${candidate.name}”。拒绝后候选会从待处理区移除；确认请单独回复“确认拒绝 Skill”。`;
  }
  const draft = candidate.draft!;
  return [
    `自动 Skill 安装确认：${candidate.name}`,
    `- 说明：${boundedText(candidate.description, 300)}`,
    `- 文件变更：${draft.risk.fileChanges.length}`,
    `- 权限：${draft.risk.permissions.length ? draft.risk.permissions.join('、') : '无额外权限'}`,
    `- 安全风险：${draft.risk.securityRisks.length ? draft.risk.securityRisks.join('、') : '未发现'}`,
    `- 脚本首次执行：${draft.risk.executionBlocked ? '仍需单独授权' : '不涉及被阻止的脚本'}`,
    '',
    '确认请单独回复“确认安装 Skill”。',
  ].join('\n');
}

async function handleExistingDraft(
  input: WorkspaceCapabilityConversationInput,
  text: string,
  draft: CapabilityDraft,
): Promise<boolean> {
  if (isCancellation(text)) {
    if (input.registry.isClaimed(input.accountId, input.sessionId)) {
      postHandled(input, text, '操作已经提交并正在处理，当前不能再撤回；最终结果会同步到对应模块。');
      return true;
    }
    input.registry.delete(input.accountId, input.sessionId);
    postHandled(input, text, '已取消当前工作区操作草稿。');
    return true;
  }

  if (draft.kind === 'knowledge') {
    const confirm = /^确认发布企业知识[。！!\s]*$/u.test(text);
    const retry = /^重新发布企业知识[。！!\s]*$/u.test(text);
    if (draft.phase === 'failed' && !retry) {
      postHandled(input, text, '上次发布结果为失败，草稿仍保留。请回复“重新发布企业知识”使用同一来源编号安全重试，或回复“取消”。');
      return true;
    }
    if (draft.phase === 'ready' && !confirm) {
      postHandled(input, text, `${knowledgeSummary(draft)}\n\n当前回复不是精确确认短语，尚未发布。`);
      return true;
    }
    if (draft.phase === 'collecting') {
      updateKnowledgeDraft(draft, text);
      input.registry.set(input.accountId, input.sessionId, draft);
      postHandled(input, text, missingKnowledgePrompt(draft));
      return true;
    }
    if (!input.registry.claim(input.accountId, input.sessionId)) {
      postHandled(input, text, '企业知识正在发布，请勿重复提交。');
      return true;
    }
    try {
      const result = await input.recordKnowledge({
        sourceId: draft.sourceId,
        title: draft.title,
        category: draft.category,
        content: draft.content,
        confidence: 0.95,
        sourceType: 'manual',
        sourceLabel: '企业管理员通过对话录入',
      });
      input.registry.delete(input.accountId, input.sessionId);
      postHandled(input, text, result.status === 'exists'
        ? '该企业知识已经发布过，本次没有产生重复记录。'
        : '企业知识已发布，并会用于后续有权限的企业知识检索。');
    } catch (error) {
      draft.phase = 'failed';
      input.registry.set(input.accountId, input.sessionId, draft);
      postHandled(input, text, `企业知识发布失败：${error instanceof Error ? error.message : String(error)}\n草稿仍保留；请回复“重新发布企业知识”重试，或回复“取消”。`);
    } finally {
      input.registry.release(input.accountId, input.sessionId);
    }
    return true;
  }

  const expected = draft.action === 'install' ? /^确认安装\s*Skill[。！!\s]*$/iu : /^确认拒绝\s*Skill[。！!\s]*$/iu;
  if (!expected.test(text)) {
    postHandled(input, text, `当前回复不是精确确认短语，尚未${draft.action === 'install' ? '安装' : '拒绝'}“${draft.candidateName}”。`);
    return true;
  }
  if (!input.registry.claim(input.accountId, input.sessionId)) {
    postHandled(input, text, '自动 Skill 操作正在处理，请勿重复提交。');
    return true;
  }
  try {
    if (draft.action === 'install') await input.confirmAutoSkill(draft.candidateId);
    else await input.rejectAutoSkill(draft.candidateId);
    input.registry.delete(input.accountId, input.sessionId);
    postHandled(input, text, `${draft.action === 'install' ? '安装' : '拒绝'}请求已提交，处理结果会同步到右侧“自动 Skill”。`);
  } catch (error) {
    postHandled(input, text, `自动 Skill 操作失败：${error instanceof Error ? error.message : String(error)}。草稿仍保留，可再次使用相同确认短语重试。`);
  } finally {
    input.registry.release(input.accountId, input.sessionId);
  }
  return true;
}

export async function handleWorkspaceCapabilityConversation(
  input: WorkspaceCapabilityConversationInput,
): Promise<boolean> {
  const text = boundedText(input.text);
  if (!text) return false;

  const existing = input.registry.get(input.accountId, input.sessionId);
  if (existing) return handleExistingDraft(input, text, existing);
  if (isIntroOrNegative(text)) return false;

  if (input.enterpriseMemoryEnabled && knowledgeWriteIntent(text)) {
    if (input.role !== 'company_admin') {
      postHandled(input, text, '只有企业管理员可以通过对话发布企业知识。你仍可以查询已发布知识。');
      return true;
    }
    const draft: KnowledgeDraft = {
      kind: 'knowledge',
      sourceId: `manual-chat:${crypto.randomUUID()}`,
      title: parseLabeledValue(text, '标题').slice(0, 120),
      category: (parseLabeledValue(text, '分类') || '企业知识').slice(0, 80),
      content: initialKnowledgeContent(text),
      phase: 'collecting',
    };
    draft.phase = draft.title && draft.content ? 'ready' : 'collecting';
    input.registry.set(input.accountId, input.sessionId, draft);
    postHandled(input, text, missingKnowledgePrompt(draft));
    return true;
  }

  if (input.enterpriseMemoryEnabled && memoryQueryIntent(text)) {
    const query = extractMemoryQuery(text);
    input.postMessage('user', text);
    try {
      const items = await input.listKnowledge(query ? { query } : {});
      input.postMessage('assistant', formatKnowledgeResults(items));
    } catch (error) {
      input.postMessage('assistant', `企业知识查询失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  if (expertListIntent(text)) {
    const experts = input.experts.filter((expert) => expert.available);
    postHandled(input, text, experts.length
      ? `当前可用专家：\n${experts.map((expert) => `- ${expert.label}`).join('\n')}\n\n你可以说“让某某专家处理……”。`
      : '当前没有可用专家。');
    return true;
  }

  const invokedExperts = expertInvocation(text, input.experts);
  if (invokedExperts.length > 1) {
    postHandled(input, text, `一句话中匹配到多个专家：${invokedExperts.map((expert) => expert.label).join('、')}。请明确选择一个。`);
    return true;
  }
  if (invokedExperts.length === 1) {
    const expert = invokedExperts[0]!;
    const task = expertTask(text, expert);
    if (!task) {
      input.selectExpert(expert);
      postHandled(input, text, `已选择“${expert.label}”。请继续输入要交给它处理的具体任务。`);
      return true;
    }
    const accepted = await input.launchExpert(expert, task);
    if (!accepted) input.postMessage('assistant', `“${expert.label}”当前未能启动，请检查连接状态后重试。`);
    return true;
  }

  if (autoSkillQueryIntent(text)) {
    postHandled(input, text, formatAutoSkills(input.autoSkillCandidates));
    return true;
  }

  const autoSkillAction = /(?:安装|启用|确认增强|增强).{0,12}(?:自动\s*Skill|Skill)/iu.test(text)
    ? 'install'
    : /(?:拒绝|删除|放弃).{0,12}(?:自动\s*Skill|Skill)/iu.test(text)
      ? 'reject'
      : null;
  if (autoSkillAction) {
    const candidate = findAutoSkillCandidate(text, input.autoSkillCandidates);
    if (!candidate) {
      postHandled(input, text, '没有找到名称完全匹配的自动 Skill 候选。请先说“查看自动 Skill 候选”。');
      return true;
    }
    if (autoSkillAction === 'install' && (
      candidate.draft?.validationPassed !== true
      || candidate.draft.packageReady !== true
    )) {
      postHandled(input, text, `“${candidate.name}”尚未通过校验或尚未完成打包，禁止安装。请在右侧“自动 Skill”查看具体错误。`);
      return true;
    }
    const draft: AutoSkillDraft = {
      kind: 'auto_skill',
      candidateId: candidate.id,
      candidateName: candidate.name,
      action: autoSkillAction,
    };
    input.registry.set(input.accountId, input.sessionId, draft);
    postHandled(input, text, autoSkillSummary(candidate, autoSkillAction));
    return true;
  }

  if (/(?:打开|进入|前往|查看)\s*(?:Skill\s*专区|技能专区)/iu.test(text)) {
    input.openSkillZone();
    postHandled(input, text, '已打开 Skill 专区。搜索、安装、评分和投稿仍在专区中完成。');
    return true;
  }

  return false;
}
