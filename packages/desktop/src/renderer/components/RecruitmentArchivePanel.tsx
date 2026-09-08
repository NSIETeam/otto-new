/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RecruitmentJobAction, RecruitmentJobHeader, RecruitmentJobResponse } from 'otto-server';
import type { RecruitmentWorkspaceStore } from '../recruitmentWorkspaceStore.js';
import { loadRecruitmentArchive, saveRecruitmentArchive, recruitmentArchiveFingerprint } from '../recruitmentArchive.js';
import { getRecruitmentAutosave } from '../recruitmentAutosave.js';

export function RecruitmentArchivePanel({ store, scopeId, disabled }: { store: RecruitmentWorkspaceStore; scopeId?: string; disabled: boolean }): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const autosaveController = getRecruitmentAutosave(store);
  const autosave = useSyncExternalStore(autosaveController.subscribe, autosaveController.getSnapshot, autosaveController.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [jobs, setJobs] = useState<RecruitmentJobHeader[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [permissionsFor, setPermissionsFor] = useState('');
  const [members, setMembers] = useState<Array<{ id: string; name: string; username: string }>>([]);
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const operation = useRef(new AbortController());
  useEffect(() => {
    operation.current = new AbortController();
    setConfirmed(false); setReplaceConfirmed(false); setDeleteConfirmed(false); setJobs([]); setMembers([]); setCollaborators([]); setSelected(''); setNextCursor(null); setCanManage(false); setBusy(false); setMessage(''); setError('');
    return () => operation.current.abort();
  }, [scopeId, store]);
  const workspaceEpoch = store.getWorkspaceEpoch();
  useEffect(() => {
    setConfirmed(false); setReplaceConfirmed(false); setDeleteConfirmed(false); setMembers([]);
  }, [state.sharedJob?.id, workspaceEpoch]);
  const dirty = !state.sharedJob || recruitmentArchiveFingerprint(state) !== state.sharedJob.savedFingerprint;
  const locked = busy || Boolean(autosave.pending) || disabled || !scopeId;
  const sharingConfirmed = confirmed || autosave.enabled;
  const permissionKey = state.sharedJob ? `${state.sharedJob.id}:${state.sharedJob.sync?.scopeToken ?? state.sharedJob.revision}` : '';
  const call = (action: RecruitmentJobAction): Promise<RecruitmentJobResponse> => {
    if (!scopeId || typeof window.otto.enterpriseRecruitmentJobs !== 'function') throw new Error('请登录企业并升级到支持共享招聘档案的客户端与服务器');
    return window.otto.enterpriseRecruitmentJobs({ scopeId, action });
  };
  const run = async (task: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const signal = operation.current.signal;
    setBusy(true); setMessage(''); setError('');
    try { await task(signal); } catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : '招聘共享操作失败'); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const accept = (result: RecruitmentJobResponse): void => {
    if (result.kind === 'job') { setCanManage(result.canManage); setPermissionsFor(`${result.job.id}:${result.sync?.scopeToken ?? result.job.revision}`); setCollaborators(result.job.collaboratorAccountIds); setSelected(result.job.id); setDeleteConfirmed(false); }
  };
  const refresh = (cursor?: string): Promise<void> => run(async (signal) => {
    const result = await call({ kind: 'list', cursor });
    if (signal.aborted) return;
    if (result.kind !== 'list') throw new Error('服务器岗位列表格式不正确');
    setJobs(result.jobs); setNextCursor(result.nextCursor);
    setMessage(result.jobs.length ? '只显示你有权访问的岗位。选中后可加载已有材料和分析。' : '本页没有可访问岗位；你可以保存自己的新岗位，再授权同事协作。');
  });
  return <details className="otto-recruitment-panel otto-recruitment-archive">
    <summary>企业共享岗位 · {state.sharedJob?.revision ? dirty ? '有未保存修改' : `已保存 v${state.sharedJob.revision}` : '仅在本地工作台'}</summary>
    <p>确认后才将本岗位候选人材料、来源、分析和人工记录保存到企业服务器。仅企业管理员、岗位创建者及授权同事可读取；不会自动发送邀请，也不会再次调用模型。</p>
    <p>共享范围：企业管理员、{state.sharedJob?.base ? '岗位创建者' : '你（新岗位创建者）'}{state.sharedJob?.base?.collaboratorAccountIds.length ? `，以及 ${state.sharedJob.base.collaboratorAccountIds.length} 位已授权同事` : '；暂无额外协作者'}。</p>
    {!scopeId ? <p>登录企业账号后可使用共享档案。个人使用仍可直接分析简历。</p> : null}
    <label><input type="checkbox" disabled={busy} checked={sharingConfirmed} onChange={(event) => { setConfirmed(event.target.checked); if (!event.target.checked) autosaveController.pause('共享确认已撤回，不再自动保存；已发出的请求可能已经保存'); }} />我确认有权将候选人材料保存到企业服务器并向本岗位授权同事共享</label>
    <div className="otto-recruitment-actions">
      <button type="button" disabled={locked || !sharingConfirmed || autosave.enabled} onClick={() => void run(async (signal) => {
        const result = await saveRecruitmentArchive(store, call, sharingConfirmed, signal);
        if (!signal.aborted) { accept(result); autosaveController.enable(true); setMessage('已开启自动保存。关闭招聘面板后仍会保存；关闭整个 Otto 后停止。'); }
      })}>保存并开启自动保存</button>
      <button type="button" disabled={locked || !sharingConfirmed} onClick={() => void run(async (signal) => {
        autosaveController.pause('本次为手动保存，自动保存已暂停');
        const result = await saveRecruitmentArchive(store, call, sharingConfirmed, signal);
        if (!signal.aborted) { accept(result); setMessage('本次已保存到企业服务器；可开启自动保存以持续同步后续修改。'); }
      })}>保存当前岗位</button>
      {autosave.enabled ? <button type="button" onClick={() => autosaveController.pause()}>暂停自动保存</button> : null}
      <button type="button" disabled={locked} onClick={() => void refresh()}>刷新企业岗位列表</button>
    </div>
    <p role={autosave.phase === 'off' ? undefined : autosave.phase === 'error' ? 'alert' : 'status'}>{autosave.message}</p>
    {error || autosave.phase === 'error' ? <div>
      <p>发生冲突时不会自动覆盖。可以先导出本地材料副本，再加载服务器版本进行核对；导出文件包含候选人个人信息，请妥善保存并按期限删除。</p>
      <button type="button" disabled={locked} onClick={() => void run(async (signal) => {
        const local = store.getSnapshot();
        const path = await window.otto.saveTextFile('招聘档案-本地材料副本.json', JSON.stringify({ format: 'otto-recruitment-local-review-v1', exportedAt: new Date().toISOString(), jobTitle: local.jobTitle, jobDescription: local.jobDescription, candidates: local.candidates, audits: local.audits }, null, 2));
        if (!signal.aborted && path) setMessage('已导出本地材料，供人工核对；当前尚不支持一键恢复该副本。服务器与本地工作台未改动。');
      })}>导出本地材料供核对</button>
    </div> : null}
    <label>企业共享岗位<select aria-label="选择企业共享岗位" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">请选择岗位</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.title} · v{job.revision}</option>)}{selected && !jobs.some((job) => job.id === selected) ? <option value={selected}>{state.jobTitle} · 当前岗位</option> : null}</select></label>
    {nextCursor ? <button type="button" disabled={locked} onClick={() => void refresh(nextCursor)}>下一页岗位</button> : null}
    <label><input type="checkbox" checked={replaceConfirmed} onChange={(event) => setReplaceConfirmed(event.target.checked)} />我已保留本地修改，允许加载或新建时替换当前工作台</label>
    <div className="otto-recruitment-actions">
      <button type="button" disabled={locked || !selected || !replaceConfirmed} onClick={() => void run(async (signal) => {
        autosaveController.pause();
        const result = await loadRecruitmentArchive(store, call, selected, signal);
        if (!signal.aborted) { accept(result); setReplaceConfirmed(false); setConfirmed(false); setMessage('已加载共享档案，右侧模块和对话继续使用这份材料；没有重新调用模型。'); }
      })}>加载选中岗位</button>
      <button type="button" disabled={locked || !replaceConfirmed} onClick={() => { autosaveController.pause(); store.resetWorkspace(); setSelected(''); setCollaborators([]); setReplaceConfirmed(false); setConfirmed(false); setMessage('已开始新的本地岗位，原共享岗位未删除。'); }}>新建本地岗位</button>
    </div>
    {(state.sharedJob?.canManage ?? canManage) && state.sharedJob && state.sharedJob.revision > 0 && permissionsFor !== permissionKey ? <button type="button" disabled={locked} onClick={() => void run(async (signal) => {
      const binding = store.getSnapshot().sharedJob!;
      const result = await call({ kind: 'get', jobId: binding.id });
      if (signal.aborted || store.getSnapshot().sharedJob !== binding) return;
      if (result.kind !== 'job' || result.job.id !== binding.id || result.job.revision !== binding.revision) throw new Error('当前岗位版本已变化，请保留修改后重新加载');
      accept(result); setMessage('已核对当前岗位授权，未修改本地材料。');
    })}>刷新当前岗位授权</button> : null}
    {(state.sharedJob?.canManage ?? canManage) && state.sharedJob && state.sharedJob.revision > 0 && permissionsFor === permissionKey ? <details>
      <summary>管理当前岗位协作者／删除共享岗位</summary>
      <p>协作者可查看和更新此岗位的全部候选人及联系方式。移除授权只会阻止后续服务器访问，无法收回对方已读取或导出的副本。</p>
      <button type="button" disabled={locked} onClick={() => void run(async (signal) => {
        const result = await window.otto.enterpriseOrganizationView();
        if (!signal.aborted && result.organization && scopeId?.startsWith(`${result.organization.id}:`)) setMembers(result.members.filter((account) => account.status === 'active').map((account) => ({ id: account.id, name: account.name, username: account.username })));
      })}>选择企业同事</button>
      <p>当前授权 {collaborators.length} 位同事</p>
      {members.map((member) => <label key={member.id}><input type="checkbox" checked={collaborators.includes(member.id)} onChange={(event) => setCollaborators((current) => event.target.checked ? [...current, member.id] : current.filter((id) => id !== member.id))} />{member.name}（{member.username}）</label>)}
      <button type="button" disabled={locked} onClick={() => void run(async (signal) => {
        autosaveController.pause('正在修改共享范围，完成后请重新确认自动保存'); setConfirmed(false);
        const binding = store.getSnapshot().sharedJob!;
        const result = await call({ kind: 'share', jobId: binding.id, expectedRevision: binding.revision, collaboratorAccountIds: collaborators });
        if (!signal.aborted && result.kind === 'job' && store.getSnapshot().sharedJob === binding) { store.setSharedJob({ ...binding, revision: result.job.revision, base: result.job, sync: result.sync, canManage: result.canManage }); accept(result); setMessage('岗位授权已更新，自动保存已暂停。请确认新的共享范围后重新开启。'); }
      })}>保存岗位授权</button>
      <label><input type="checkbox" checked={deleteConfirmed} onChange={(event) => setDeleteConfirmed(event.target.checked)} />确认删除当前共享岗位及服务器上的全部候选人材料（本地副本不删除）</label>
      <button type="button" className="is-danger" disabled={locked || !deleteConfirmed} onClick={() => void run(async (signal) => {
        autosaveController.pause(); setConfirmed(false);
        const binding = store.getSnapshot().sharedJob!;
        const result = await call({ kind: 'delete', jobId: binding.id, expectedRevision: binding.revision });
        if (!signal.aborted && result.kind === 'deleted' && store.getSnapshot().sharedJob === binding) { store.setSharedJob(null); setDeleteConfirmed(false); setJobs((current) => current.filter((job) => job.id !== binding.id)); setSelected(''); setMessage('共享岗位及服务器当前材料已删除。本地材料仍在；备份副本按服务器备份保留策略处理。'); }
      })}>删除共享岗位</button>
    </details> : null}
    {busy ? <p role="status">正在处理企业档案…</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <small>自动保存仅在本次 Otto 运行期间生效；切换岗位、账号或修改共享范围后需重新确认。关闭应用前请等到“已保存”，未同步的修改仍可能丢失。候选人删除会在下一次保存时同步，不会删除同事已导出的副本。此功能不是服务器自动收件或自动分析。</small>
  </details>;
}
