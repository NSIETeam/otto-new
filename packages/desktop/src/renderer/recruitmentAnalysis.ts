/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

/**
 * Otto 官方招聘模块的可审计规则层。
 *
 * 设计参考 Aural 的逐题 rubric、Vekt 的材料处理链路与 CandiSift 的 PII
 * 分离思路，但实现完全独立。此层不产生“录用概率”或自动淘汰结论；只输出
 * 原文证据、缺失证据和待核实问题，最终决定必须由人工作出。
 */

export const RECRUITMENT_ANALYSIS_VERSION = 'otto-recruitment-evidence-v1.0';

export interface CandidateIdentity {
  name?: string;
  phone?: string;
  email?: string;
  gender?: string;
  age?: string;
  birthDate?: string;
}

export interface ResumeEvidence {
  line: number;
  quote: string;
}

export interface CandidateFinding {
  id: string;
  criterion: string;
  requirement: 'required' | 'preferred';
  status: 'supported' | 'uncertain' | 'missing';
  evidence: ResumeEvidence[];
  matchedTerms: string[];
  missingTerms: string[];
  rule: string;
  confidence: number;
}

export interface CandidateResumeAnalysis {
  candidateId: string;
  identity: CandidateIdentity;
  redactedResume: string;
  skills: string[];
  timeline: string[];
  experiences: string[];
  projects: string[];
  findings: CandidateFinding[];
  questions: string[];
  engineVersion: string;
  createdAt: string;
}

export interface InterviewQuestion {
  id: string;
  criterion: string;
  question: string;
  followUps: string[];
  rubric: string;
}

export interface InterviewKit {
  candidateId: string;
  questions: InterviewQuestion[];
  generatedAt: string;
  engineVersion: string;
}

export interface TranscriptSegment {
  speaker: string;
  startSeconds: number;
  endSeconds?: number;
  text: string;
}

export interface StarEvidence {
  segmentIndex: number;
  timestamp: number;
  situation: boolean;
  task: boolean;
  action: boolean;
  result: boolean;
  quote: string;
}

export interface InterviewKnowledgeEvidence {
  criterion: string;
  status: 'supported' | 'uncertain' | 'missing';
  evidence: Array<{ timestamp: number; quote: string }>;
  matchedTerms: string[];
  missingTerms: string[];
  rule: string;
  confidence: number;
}

export interface InterviewTranscriptAnalysis {
  segments: TranscriptSegment[];
  starEvidence: StarEvidence[];
  knowledgeEvidence: InterviewKnowledgeEvidence[];
  incompleteAnswers: string[];
  inconsistencies: string[];
  contentNotice: string;
  engineVersion: string;
}

export interface HiringDecisionAudit {
  id: string;
  candidateId: string;
  reviewerId: string;
  actorType: 'human';
  decision: 'shortlist' | 'hold' | 'reject';
  rationale: string;
  modelVersion: null;
  createdAt: string;
}

const IDENTITY_PATTERNS = {
  phone: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/u,
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  gender: /(?:性别|gender)\s*[:：]?\s*(男|女|男性|女性|male|female)/iu,
  age: /(?:年龄|age)\s*[:：]?\s*(\d{1,3})\s*岁?/iu,
  birthDate: /(?:出生(?:日期|年月)?|生日|birth(?:day|date)?)\s*[:：]?\s*([12]\d{3}(?:[-/.年]\d{1,2})?(?:[-/.月]\d{1,2}日?)?)/iu,
} as const;

const REQUIREMENT_PREFIX = /^(?:必须|要求|应聘者需|任职要求|具备|熟悉|熟练掌握|精通|掌握|优先考虑|有|能够|负责)\s*/u;
const REQUIREMENT_SUFFIX = /(?:相关)?(?:工作|项目|开发)?经验(?:优先)?$/u;
const STOP_TERMS = new Set([
  '必须', '要求', '具备', '熟悉', '熟练掌握', '精通', '掌握', '优先', '经验',
  '相关', '能够', '负责', '工作', '项目', '开发', '以上', '岗位', '候选人',
]);

function cleanText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function findIdentity(text: string): CandidateIdentity {
  const lines = cleanText(text).split('\n').map((line) => line.trim()).filter(Boolean);
  const firstLine = lines.find((line) => (
    /^[\p{Script=Han}·]{2,8}$/u.test(line) || /^[A-Za-z][A-Za-z .'-]{1,40}$/u.test(line)
  ));
  return {
    ...(firstLine ? { name: firstLine } : {}),
    ...(text.match(IDENTITY_PATTERNS.phone)?.[0]
      ? { phone: text.match(IDENTITY_PATTERNS.phone)![0] } : {}),
    ...(text.match(IDENTITY_PATTERNS.email)?.[0]
      ? { email: text.match(IDENTITY_PATTERNS.email)![0] } : {}),
    ...(text.match(IDENTITY_PATTERNS.gender)?.[1]
      ? { gender: text.match(IDENTITY_PATTERNS.gender)![1] } : {}),
    ...(text.match(IDENTITY_PATTERNS.age)?.[1]
      ? { age: text.match(IDENTITY_PATTERNS.age)![1] } : {}),
    ...(text.match(IDENTITY_PATTERNS.birthDate)?.[1]
      ? { birthDate: text.match(IDENTITY_PATTERNS.birthDate)![1] } : {}),
  };
}

export function redactCandidateIdentity(text: string): {
  identity: CandidateIdentity;
  redactedText: string;
} {
  const normalized = cleanText(text);
  const identity = findIdentity(normalized);
  const sensitiveValues = Object.values(identity).filter(Boolean) as string[];
  let redactedText = normalized;
  for (const value of sensitiveValues) {
    redactedText = redactedText.replaceAll(value, '[已隔离]');
  }
  redactedText = redactedText
    .replace(/^(?:姓名|电话|手机|邮箱|电子邮箱|性别|年龄|出生(?:日期|年月)?|生日)\s*[:：].*$/gimu, '[敏感身份字段已隔离]')
    .replace(/^\[已隔离\]$/gmu, '[敏感身份字段已隔离]');
  return { identity, redactedText };
}

function splitCriteria(jobDescription: string): string[] {
  return cleanText(jobDescription)
    .split(/[\n；;。]+/u)
    .map((line) => line.replace(/^[\s\-*•\d.、)）]+/u, '').trim())
    .filter((line) => line.length >= 2);
}

const KNOWN_TERMS = [
  'TypeScript', 'JavaScript', 'React', 'Vue', 'Angular', 'Node.js', 'Node', 'Electron',
  'Rust', 'Python', 'Java', 'Go', 'C++', 'SQL', 'Docker', 'Kubernetes', 'Git', 'Linux',
  '项目管理', '团队协作', '需求分析', '产品设计', '客户沟通', '数据分析', '机器学习',
  '深度学习', '自然语言处理', '销售', '招聘', '财务', '法务', '运营', '交付',
] as const;

function criterionTerms(criterion: string): string[] {
  const terms: string[] = [];
  for (const known of KNOWN_TERMS) {
    if (criterion.toLowerCase().includes(known.toLowerCase())) terms.push(known);
  }
  const years = criterion.match(/\d+\s*年/u)?.[0]?.replace(/\s/g, '');
  if (years) terms.push(years);
  for (const fragment of criterion.split(/[，、,/()（）\s]+/u)) {
    let withoutPrefix = fragment.trim();
    while (REQUIREMENT_PREFIX.test(withoutPrefix)) {
      withoutPrefix = withoutPrefix.replace(REQUIREMENT_PREFIX, '').trim();
    }
    const cleaned = withoutPrefix
      .replace(REQUIREMENT_SUFFIX, '')
      .replace(/(?:经验)?优先$/u, '')
      .trim();
    if (cleaned.length < 2 || cleaned.length > 18 || STOP_TERMS.has(cleaned)) continue;
    if (!terms.some((term) => term.toLowerCase() === cleaned.toLowerCase())) terms.push(cleaned);
  }
  return terms.slice(0, 6);
}

function matchingEvidence(lines: readonly string[], terms: readonly string[]): ResumeEvidence[] {
  const evidence: ResumeEvidence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.includes('[敏感身份字段已隔离]')) continue;
    if (terms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) {
      evidence.push({ line: index + 1, quote: line.trim() });
    }
    if (evidence.length >= 3) break;
  }
  return evidence;
}

function extractDistinctMatches(text: string, expression: RegExp): string[] {
  return [...new Set(Array.from(text.matchAll(expression), (match) => match[0].trim()))];
}

export function analyzeCandidateResume(input: {
  candidateId: string;
  resumeText: string;
  jobDescription: string;
  now?: string;
}): CandidateResumeAnalysis {
  const { identity, redactedText } = redactCandidateIdentity(input.resumeText);
  const lines = redactedText.split('\n');
  const criteria = splitCriteria(input.jobDescription);
  const findings = criteria.map<CandidateFinding>((criterion, index) => {
    const terms = criterionTerms(criterion);
    const matchedTerms = terms.filter((term) => (
      redactedText.toLowerCase().includes(term.toLowerCase())
    ));
    const missingTerms = terms.filter((term) => !matchedTerms.includes(term));
    const evidence = matchingEvidence(lines, matchedTerms);
    const ratio = terms.length > 0 ? matchedTerms.length / terms.length : 0;
    const status = evidence.length === 0 || ratio === 0
      ? 'missing'
      : ratio >= 0.6 ? 'supported' : 'uncertain';
    const requirement = /必须|要求|任职|应当|至少|\d+\s*年/u.test(criterion)
      ? 'required' : 'preferred';
    return {
      id: `criterion-${index + 1}`,
      criterion,
      requirement,
      status,
      evidence,
      matchedTerms,
      missingTerms,
      rule: status === 'supported'
        ? '简历原文包含岗位条件中的主要可核验术语'
        : status === 'uncertain'
          ? '只找到部分术语，需要面试补充职责、规模和结果证据'
          : '简历中未找到直接支持该条件的原文',
      confidence: status === 'supported'
        ? Math.min(0.95, 0.62 + ratio * 0.3)
        : status === 'uncertain' ? 0.58 : 0.72,
    };
  });
  const questions = findings
    .filter((finding) => finding.status !== 'supported')
    .map((finding) => `请候选人补充“${finding.criterion}”的具体场景、本人行动、量化结果和可核实对象。`);
  return {
    candidateId: input.candidateId,
    identity,
    redactedResume: redactedText,
    skills: [...new Set(KNOWN_TERMS.filter((term) => (
      redactedText.toLowerCase().includes(term.toLowerCase())
    )))],
    timeline: extractDistinctMatches(redactedText, /(?:19|20)\d{2}\s*(?:[-–—~至到]\s*(?:(?:19|20)\d{2}|至今|现在))?/gu),
    experiences: lines.filter((line) => (
      /(?:19|20)\d{2}.*(?:公司|集团|科技|工程师|经理|主管|总监|顾问|实习|任职|工作)/u.test(line)
    )).slice(0, 12),
    projects: lines.filter((line) => /项目|负责|主导|参与|交付/u.test(line)).slice(0, 12),
    findings,
    questions,
    engineVersion: RECRUITMENT_ANALYSIS_VERSION,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function generateInterviewKit(
  analysis: CandidateResumeAnalysis,
  now = new Date().toISOString(),
): InterviewKit {
  const targets = analysis.findings.filter((finding) => finding.status !== 'supported');
  const fallback = analysis.findings.slice(0, 3);
  return {
    candidateId: analysis.candidateId,
    questions: (targets.length ? targets : fallback).map((finding, index) => ({
      id: `question-${index + 1}`,
      criterion: finding.criterion,
      question: `请用一个真实项目说明你如何满足“${finding.criterion}”。`,
      followUps: [
        '当时的背景、目标和约束是什么？',
        '哪些行动由你本人完成？',
        '结果如何量化，谁可以验证？',
      ],
      rubric: '必须包含情境、任务、本人行动、结果以及至少一项可核验事实；不得用团队成果替代个人贡献。',
    })),
    generatedAt: now,
    engineVersion: RECRUITMENT_ANALYSIS_VERSION,
  };
}

function timestampToSeconds(value: string): number {
  const parts = value.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

export function parseInterviewTranscript(transcript: string): TranscriptSegment[] {
  return cleanText(transcript).split('\n').filter(Boolean).map((line, index) => {
    const match = line.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^：:]{1,24})[：:]\s*(.+)$/u);
    if (match) {
      return { speaker: match[2].trim(), startSeconds: timestampToSeconds(match[1]), text: match[3].trim() };
    }
    const speakerMatch = line.match(/^([^：:]{1,24})[：:]\s*(.+)$/u);
    return {
      speaker: speakerMatch?.[1]?.trim() || '说话人待确认',
      startSeconds: index * 30,
      text: speakerMatch?.[2]?.trim() || line.trim(),
    };
  });
}

export function analyzeInterviewTranscript(input: {
  transcript: string;
  redactedResume: string;
  jobDescription?: string;
}): InterviewTranscriptAnalysis {
  const segments = parseInterviewTranscript(input.transcript);
  const candidateSegments = segments.filter((segment) => !/面试官|interviewer/iu.test(segment.speaker));
  const starEvidence = candidateSegments.map<StarEvidence>((segment) => ({
    segmentIndex: segments.indexOf(segment),
    timestamp: segment.startSeconds,
    situation: /当时|背景|场景|项目/u.test(segment.text),
    task: /负责|目标|任务|需要/u.test(segment.text),
    action: /我(?:先|负责|完成|设计|实现|推动|协调)|行动|采用/u.test(segment.text),
    result: /最终|结果|提升|降低|增长|减少|完成|交付|\d+%/u.test(segment.text),
    quote: segment.text,
  }));
  const incompleteAnswers = starEvidence
    .filter((item) => [item.situation, item.task, item.action, item.result].filter(Boolean).length < 2)
    .map((item) => `第 ${item.segmentIndex + 1} 段缺少完整 STAR 证据，需要追问背景、本人行动或结果。`);
  const knowledgeEvidence = splitCriteria(input.jobDescription ?? '').map<InterviewKnowledgeEvidence>((criterion) => {
    const terms = criterionTerms(criterion);
    const matchedTerms = terms.filter((term) => candidateSegments.some((segment) => (
      segment.text.toLowerCase().includes(term.toLowerCase())
    )));
    const missingTerms = terms.filter((term) => !matchedTerms.includes(term));
    const evidence = candidateSegments
      .filter((segment) => matchedTerms.some((term) => (
        segment.text.toLowerCase().includes(term.toLowerCase())
      )))
      .slice(0, 3)
      .map((segment) => ({ timestamp: segment.startSeconds, quote: segment.text }));
    const ratio = terms.length > 0 ? matchedTerms.length / terms.length : 0;
    const status = evidence.length === 0 || ratio === 0
      ? 'missing'
      : ratio >= 0.6 ? 'supported' : 'uncertain';
    return {
      criterion,
      status,
      evidence,
      matchedTerms,
      missingTerms,
      rule: status === 'supported'
        ? '回答原文覆盖岗位知识条件中的主要可核验术语'
        : status === 'uncertain'
          ? '回答只覆盖部分岗位知识术语，需要继续追问方法、边界和实际应用'
          : '回答中未找到该岗位知识条件的直接证据',
      confidence: status === 'supported'
        ? Math.min(0.93, 0.6 + ratio * 0.3)
        : status === 'uncertain' ? 0.56 : 0.7,
    };
  });
  const resumeNumbers = new Set(input.redactedResume.match(/(?<!\d)\d+(?:\.\d+)?%?(?!\d)/gu) ?? []);
  const transcriptNumbers = new Set(candidateSegments.flatMap((segment) => (
    segment.text.match(/(?<!\d)\d+(?:\.\d+)?%?(?!\d)/gu) ?? []
  )));
  const resumeDifferences = [...transcriptNumbers]
    .filter((value) => !resumeNumbers.has(value))
    .map((value) => `录音回答中出现“${value}”，简历未找到对应数字证据，请人工核实而不是直接判定矛盾。`);
  const numericClaims = new Map<string, Set<string>>();
  for (const segment of candidateSegments) {
    for (const match of segment.text.matchAll(/(团队|人数|成员|周期|工期|预算|成本|提升|降低|增长|减少|用户|客户)[^。；，,\n]{0,12}?(\d+(?:\.\d+)?%?)/gu)) {
      const [, topic, value] = match;
      const values = numericClaims.get(topic) ?? new Set<string>();
      values.add(value);
      numericClaims.set(topic, values);
    }
  }
  const internalDifferences = [...numericClaims.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([topic, values]) => (
      `录音回答对“${topic}”出现多个数值（${[...values].join('、')}），请人工核实上下文、口径和时间范围。`
    ));
  const inconsistencies = [...internalDifferences, ...resumeDifferences];
  return {
    segments,
    starEvidence,
    knowledgeEvidence,
    incompleteAnswers,
    inconsistencies,
    contentNotice: '仅分析回答内容和证据，不分析口音、音高、表情、情绪、性格或所谓自信程度。',
    engineVersion: RECRUITMENT_ANALYSIS_VERSION,
  };
}

function reportTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remaining = safe % 60;
  return hours > 0
    ? [hours, minutes, remaining].map((value) => String(value).padStart(2, '0')).join(':')
    : [minutes, remaining].map((value) => String(value).padStart(2, '0')).join(':');
}

export function buildInterviewRecord(input: {
  jobTitle: string;
  candidate: CandidateResumeAnalysis;
  transcript: InterviewTranscriptAnalysis;
  reviewerNotes?: string;
}): string {
  const knowledgeRows = input.transcript.knowledgeEvidence.flatMap((finding) => [
    `### ${finding.criterion}`,
    '',
    `- 证据状态：${finding.status === 'supported' ? '有直接证据' : finding.status === 'uncertain' ? '证据不足' : '未找到证据'}`,
    `- 匹配规则：${finding.rule}`,
    `- 规则可信度：${Math.round(finding.confidence * 100)}%`,
    ...(finding.evidence.length
      ? finding.evidence.map((evidence) => `- [${reportTimestamp(evidence.timestamp)}] ${evidence.quote}`)
      : ['- 回答中没有可直接引用的证据。']),
    '',
  ]);
  return [
    '# 面试记录',
    '',
    `- 岗位：${input.jobTitle || '未命名岗位'}`,
    `- 候选人：${input.candidate.identity.name || input.candidate.candidateId}`,
    `- 分析引擎：${input.transcript.engineVersion}`,
    '- 决策边界：本记录不包含自动录用、淘汰或排序结论。',
    '',
    '## 带时间戳转写',
    '',
    ...input.transcript.segments.map((segment) => (
      `- [${reportTimestamp(segment.startSeconds)}] ${segment.speaker}：${segment.text}`
    )),
    '',
    '## 岗位知识证据',
    '',
    ...(knowledgeRows.length ? knowledgeRows : ['未提供岗位条件，未生成岗位知识证据。', '']),
    '## STAR 与待核实事项',
    '',
    ...input.transcript.incompleteAnswers.map((item) => `- ${item}`),
    ...input.transcript.inconsistencies.map((item) => `- ${item}`),
    ...(!input.transcript.incompleteAnswers.length && !input.transcript.inconsistencies.length
      ? ['- 暂无规则命中的待核实项；仍需招聘人员复核完整录音。'] : []),
    '',
    '## 招聘人员记录',
    '',
    input.reviewerNotes?.trim() || '待填写。',
  ].join('\n');
}

export function createHumanHiringDecision(input: {
  candidateId: string;
  reviewerId: string;
  decision: HiringDecisionAudit['decision'];
  rationale: string;
  confirmed: boolean;
  now?: string;
}): HiringDecisionAudit {
  if (!input.confirmed) throw new Error('最终筛选或淘汰必须由招聘人员人工确认');
  if (input.rationale.trim().length < 6) throw new Error('请填写至少 6 个字的人工判断依据');
  return {
    id: `hiring-decision:${input.candidateId}:${crypto.randomUUID()}`,
    candidateId: input.candidateId,
    reviewerId: input.reviewerId,
    actorType: 'human',
    decision: input.decision,
    rationale: input.rationale.trim(),
    modelVersion: null,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function buildCandidateComparisonReport(
  analyses: readonly CandidateResumeAnalysis[],
): string {
  const rows = analyses.map((analysis) => {
    const supported = analysis.findings.filter((finding) => finding.status === 'supported').length;
    const uncertain = analysis.findings.filter((finding) => finding.status === 'uncertain').length;
    const missing = analysis.findings.filter((finding) => finding.status === 'missing').length;
    return `| ${analysis.identity.name || analysis.candidateId} | ${supported} | ${uncertain} | ${missing} | ${analysis.questions.length} |`;
  });
  return [
    '# 候选人证据对比报告',
    '',
    '> 本报告不提供自动排名或录用概率；所有结论必须由招聘人员复核原文证据。',
    '',
    '| 候选人 | 已支持条件 | 待核实条件 | 缺失条件 | 建议追问 |',
    '|---|---:|---:|---:|---:|',
    ...rows,
  ].join('\n');
}
