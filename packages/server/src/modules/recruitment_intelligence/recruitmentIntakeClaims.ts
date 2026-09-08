/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import { RecruitmentJobError, recruitmentJobId, type RecruitmentJobActor, type RecruitmentSharedJob } from './recruitmentJobs.js';
import { recruitmentSyncMetadata } from './recruitmentCollaboration.js';

export interface RecruitmentIntakeClaim {
  id: string; requestId: string; actorAccountId: string; candidateId: string;
  status: 'claimed' | 'started' | 'completed' | 'unknown'; createdAt: string; expiresAt: string; finishedAt?: string;
  scopeToken: string; headerToken: string; message: string;
}
interface Target { jobId: string; itemId: string }
export type RecruitmentIntakeClaimAction =
  | Target & { kind: 'claim_intake_analysis'; requestId: string; candidateId: string; scopeToken: string; headerToken: string; confirmed: true }
  | Target & { kind: 'start_intake_analysis'; requestId: string; claimId: string }
  | Target & { kind: 'finish_intake_analysis'; requestId: string; claimId: string; outcome: 'completed' | 'unknown' }
  | Target & { kind: 'reset_intake_analysis'; claimId: string; confirmed: true; scopeToken: string; headerToken: string };

/** Claims are durable exclusions, not leases which silently become another paid attempt. */
export function applyRecruitmentIntakeClaim(job: RecruitmentSharedJob, actor: RecruitmentJobActor, action: RecruitmentIntakeClaimAction, now: string): RecruitmentSharedJob {
  if (!actor.active || (!actor.isAdmin && job.ownerAccountId !== actor.id && !job.collaboratorAccountIds.includes(actor.id))) throw new RecruitmentJobError(403, '岗位不可访问');
  if (job.id !== action.jobId || typeof action.itemId !== 'string' || !/^[a-f0-9]{64}$/u.test(action.itemId)) throw new RecruitmentJobError(400, '待处理材料标识无效');
  const item = job.incomingMaterials?.find((entry) => entry.id === action.itemId && Date.parse(entry.expiresAt) > Date.parse(now));
  if (!item) throw new RecruitmentJobError(404, '待处理材料已到期、已删除或不属于此岗位');
  const sync = recruitmentSyncMetadata(job); const old = item.manualAnalysis;
  let next: RecruitmentIntakeClaim | undefined; let history = item.manualAnalysisHistory;
  if (action.kind === 'claim_intake_analysis') {
    if (action.confirmed !== true) throw new RecruitmentJobError(400, '请确认分析和岗位共享权限');
    if (action.scopeToken !== sync.scopeToken || action.headerToken !== sync.headerToken) throw new RecruitmentJobError(409, '岗位要求或共享范围已变化，请重新加载');
    if (old) throw new RecruitmentJobError(409, '此材料已被认领或处理；请刷新共享档案，不要重复付费分析');
    if (item.analysis || job.backgroundAnalysis?.pending?.itemId === item.id) throw new RecruitmentJobError(409, '后台已尝试处理此材料，请刷新并查看结果');
    if (item.material.material.completeness !== 'full_text' || item.material.material.text.trim().length < 20) throw new RecruitmentJobError(400, '材料没有足够的完整正文');
    next = { id: randomUUID(), requestId: recruitmentJobId(action.requestId), candidateId: recruitmentJobId(action.candidateId), actorAccountId: actor.id,
      status: 'claimed', createdAt: now, expiresAt: new Date(Date.parse(now) + 180_000).toISOString(), scopeToken: sync.scopeToken, headerToken: sync.headerToken,
      message: '已由招聘同事认领；后台不会重复分析。尚未确认是否发出模型请求' };
  } else {
    if (!old || action.claimId !== old.id) throw new RecruitmentJobError(409, '认领记录已变化，请刷新');
    if (action.kind === 'reset_intake_analysis') {
      if (!actor.isAdmin && job.ownerAccountId !== actor.id) throw new RecruitmentJobError(403, '仅岗位创建者或企业管理员可确认重新处理');
      if (action.confirmed !== true || action.scopeToken !== sync.scopeToken || action.headerToken !== sync.headerToken) throw new RecruitmentJobError(409, '请核对岗位范围和模型用量后确认重新处理');
      if (old.status !== 'completed' && Date.parse(old.expiresAt) > Date.parse(now)) throw new RecruitmentJobError(409, '客户端请求可能仍在执行，请等待截止时间后核对用量');
      if ((history?.length ?? 0) >= 10) throw new RecruitmentJobError(409, '已达到 10 次人工重新处理上限，请先整理材料');
      history = [old, ...history ?? []];
    } else {
      if (old.actorAccountId !== actor.id || old.requestId !== action.requestId) throw new RecruitmentJobError(403, '只有原账号的本次请求可以启动或回报认领结果');
      const current = old.scopeToken === sync.scopeToken && old.headerToken === sync.headerToken && Date.parse(old.expiresAt) > Date.parse(now);
      if (action.kind === 'start_intake_analysis') {
        if (old.status !== 'claimed' || !current) throw new RecruitmentJobError(409, '认领已启动、到期或范围变化；不会重复发出模型请求');
        next = { ...old, status: 'started', message: '客户端正在分析；中断后结果和计费可能未知，后台不会接替重试' };
      } else {
        if (!['completed', 'unknown'].includes(action.outcome)) throw new RecruitmentJobError(400, '客户端回报状态无效');
        if (old.status === 'completed' || old.status === 'unknown') return job;
        const completed = current && old.status === 'started' && action.outcome === 'completed';
        next = { ...old, status: completed ? 'completed' : 'unknown', finishedAt: now,
          message: completed ? '客户端报告已完成分析（可能复用）；结果在对应候选人档案中，是否已共享请刷新核对' : '客户端未确认完成或授权范围已变化；可能已计费，不自动重试，请核对原客户端与厂商用量' };
      }
    }
  }
  const incomingMaterials = job.incomingMaterials!.map((entry) => entry.id === item.id ? { ...entry, manualAnalysis: next, ...(history ? { manualAnalysisHistory: history } : {}) } : entry);
  if (Buffer.byteLength(JSON.stringify([job.candidates, incomingMaterials]), 'utf8') > 5_900_000) throw new RecruitmentJobError(400, '岗位档案超过容量上限');
  return { ...job, incomingMaterials, revision: job.revision + 1, updatedAt: now, updatedBy: actor.id };
}
