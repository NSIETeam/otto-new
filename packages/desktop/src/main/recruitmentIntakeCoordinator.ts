/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { RecruitmentJobAction, RecruitmentJobResponse, RecruitmentIntakeClaim } from 'otto-server';
import type { RecruitmentSemanticAnalysisInput, RecruitmentSemanticEvaluation } from './recruitmentSemantic.js';

/** Main-process gate: a lost permit response never falls back to an uncoordinated paid call. */
export async function coordinateRecruitmentIntakeAnalysis(input: RecruitmentSemanticAnalysisInput, options: {
  call(action: RecruitmentJobAction): Promise<RecruitmentJobResponse>;
  analyze(input: RecruitmentSemanticAnalysisInput, signal?: AbortSignal): Promise<RecruitmentSemanticEvaluation>;
  assertScope(scopeId: string): void; getSessionKey(): string;
}): Promise<RecruitmentSemanticEvaluation> {
  if (input.sharedIntake === undefined) return options.analyze(input);
  const context = input.sharedIntake;
  const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  if (!context || typeof context !== 'object' || !id(context.scopeId) || !id(context.jobId) || !hash(context.itemId) || !hash(context.scopeToken) || !hash(context.headerToken)) throw new Error('共享待处理分析上下文无效，未调用模型');
  const request = { ...context }; options.assertScope(request.scopeId); const session = options.getSessionKey();
  const assertCurrent = (): void => { options.assertScope(request.scopeId); if (options.getSessionKey() !== session) throw new Error('企业账号或服务器连接已变化，未采用旧分析'); };
  const requestId = randomUUID();
  const base = { jobId: request.jobId, itemId: request.itemId, requestId };
  const claimed = await options.call({ ...base, kind: 'claim_intake_analysis', candidateId: input.candidateId, scopeToken: request.scopeToken, headerToken: request.headerToken, confirmed: true });
  assertCurrent();
  const claimFrom = (response: RecruitmentJobResponse, status: RecruitmentIntakeClaim['status']): RecruitmentIntakeClaim => {
    if (response.kind !== 'job' || response.job.id !== request.jobId || response.job.title !== input.jobTitle || response.job.description !== input.jobDescription) throw new Error('共享岗位响应不匹配，未取得分析启动许可');
    const claim = response.job.incomingMaterials?.find((item) => item.id === request.itemId && Date.parse(item.expiresAt) > Date.now())?.manualAnalysis;
    if (!claim || !id(claim.id) || claim.status !== status || claim.requestId !== requestId || claim.candidateId !== input.candidateId || claim.scopeToken !== request.scopeToken || claim.headerToken !== request.headerToken || !Number.isFinite(Date.parse(claim.expiresAt)) || Date.parse(claim.expiresAt) <= Date.now()) throw new Error('材料认领响应未确认，不会重复发出模型请求');
    return claim;
  };
  const claim = claimFrom(claimed, 'claimed'); const finish = async (outcome: 'completed' | 'unknown'): Promise<boolean> => {
    let result: RecruitmentJobResponse;
    try {
      assertCurrent(); result = await options.call({ ...base, kind: 'finish_intake_analysis', claimId: claim.id, outcome }); assertCurrent();
    } catch (error) {
      // An authoritative denial is not a network outage. Do not retain a stale
      // shared result after revocation, deletion or replacement of its claim.
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (outcome === 'completed' && [401, 403, 404, 409].includes(Number(status))) throw new Error('共享材料权限、岗位或认领已变化，本次结果未采用；请刷新并核对用量');
      return false;
    }
    if (outcome === 'completed') {
      if (claimFrom(result, 'completed').id !== claim.id) throw new Error('完成记录与本次认领不一致，结果未采用');
      return true;
    }
    return false;
  };
  let evaluation: RecruitmentSemanticEvaluation;
  try {
    assertCurrent();
    const started = await options.call({ ...base, kind: 'start_intake_analysis', claimId: claim.id }); assertCurrent();
    if (claimFrom(started, 'started').id !== claim.id) throw new Error('启动许可与本次认领不一致');
    const signal = AbortSignal.timeout(90_000);
    evaluation = await options.analyze({ ...input, sharedIntake: undefined }, signal);
    signal.throwIfAborted(); assertCurrent();
  } catch (error) { await finish('unknown'); throw error; }
  const recorded = await finish('completed'); assertCurrent();
  return { ...evaluation, coordination: { claimId: claim.id, status: recorded ? 'recorded' : 'unconfirmed', message: recorded
    ? '共享材料的手动分析已登记，后台不会重复处理；候选人结果仍通过共享档案保存'
    : '分析结果已保留在本客户端，但服务器未确认完成记录；请刷新并核对共享保存状态，不要直接重复付费分析' } };
}
