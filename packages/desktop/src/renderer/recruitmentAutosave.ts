/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { recruitmentArchiveFingerprint, refreshRecruitmentArchive, saveRecruitmentArchive, type RecruitmentArchiveCall } from './recruitmentArchive.js';
import type { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
// Import only the browser-safe lifecycle service, never Core's Node entry point.
import { RecurringTaskRegistry } from 'otto-core/recurring-tasks';

export interface RecruitmentAutosaveStatus {
  enabled: boolean; phase: 'off' | 'watching' | 'queued' | 'saving' | 'refreshing' | 'paused' | 'error'; message: string;
  pending?: boolean;
}
/** Owned by App, not the dialog. No persistence of consent, credentials or raw candidate material. */
export class RecruitmentAutosave {
  private status: RecruitmentAutosaveStatus = { enabled: false, phase: 'off', message: '自动保存未开启' };
  private readonly listeners = new Set<() => void>();
  private lifecycle?: { call: RecruitmentArchiveCall; abort: AbortController; unsubscribe: () => void; busy: boolean };
  private timer?: ReturnType<typeof setTimeout>;
  private stopPoll?: () => void;
  private consent?: { jobId: string; scopeToken: string; epoch: number };
  constructor(private readonly store: RecruitmentWorkspaceStore, private readonly delay = 800, private readonly pollInterval = 30_000) {}
  getSnapshot = (): RecruitmentAutosaveStatus => this.status;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  private emit(status: RecruitmentAutosaveStatus): void { this.status = { ...status, pending: Boolean(this.lifecycle?.busy) }; this.listeners.forEach((fn) => fn()); }
  private clear(): void { clearTimeout(this.timer); this.stopPoll?.(); this.timer = undefined; this.stopPoll = undefined; }
  start(call: RecruitmentArchiveCall): () => void {
    this.stop();
    const lifecycle = { call, abort: new AbortController(), unsubscribe: this.store.subscribe(() => this.changed()), busy: false };
    this.lifecycle = lifecycle;
    return () => { if (this.lifecycle === lifecycle) this.stop(); };
  }
  private stop(): void {
    this.clear(); this.lifecycle?.abort.abort(); this.lifecycle?.unsubscribe(); this.lifecycle = undefined; this.consent = undefined;
    this.emit({ enabled: false, phase: 'off', message: '自动保存未开启；重启或切换账号后需重新确认' });
  }
  enable(confirmed: boolean): void {
    if (!confirmed) throw new Error('请先确认候选人材料的企业共享范围');
    if (!this.lifecycle) throw new Error('自动保存服务尚未就绪');
    const binding = this.store.getSnapshot().sharedJob;
    if (!binding?.revision || !binding.sync || !binding.base) throw new Error('请先保存或加载岗位，并升级到支持候选人级协作的服务器');
    this.consent = { jobId: binding.id, scopeToken: binding.sync.scopeToken, epoch: this.store.getWorkspaceEpoch() };
    this.clear(); this.emit({ enabled: true, phase: 'watching', message: '自动保存已开启 · 仅同步档案，不调用模型' });
    this.stopPoll = new RecurringTaskRegistry().register({
      name: 'desktop.recruitment-autosave',
      source: 'packages/desktop/src/renderer/recruitmentAutosave.ts',
      intervalMs: this.pollInterval,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => String(Date.now()),
      run: async () => { if (!this.lifecycle?.busy && !this.timer) await this.execute(true); },
    });
    this.changed();
  }
  pause(message = '自动保存已暂停；本地修改仍保留'): void {
    this.clear(); this.consent = undefined;
    // An already dispatched request may have reached the server; let its acknowledgement settle.
    this.emit({ enabled: false, phase: 'paused', message });
  }
  private changed(): void {
    if (!this.status.enabled || !this.consent) return;
    const current = this.store.getSnapshot(); const binding = current.sharedJob;
    if (binding?.id !== this.consent.jobId || binding.sync?.scopeToken !== this.consent.scopeToken || this.store.getWorkspaceEpoch() !== this.consent.epoch) {
      this.pause('岗位或共享范围已变化，自动保存已暂停，请重新确认'); return;
    }
    if (this.lifecycle?.busy) return;
    clearTimeout(this.timer); this.timer = undefined;
    if (recruitmentArchiveFingerprint(current) !== binding.savedFingerprint) {
      this.emit({ enabled: true, phase: 'queued', message: '有修改待自动保存…' });
      this.timer = setTimeout(() => { this.timer = undefined; void this.execute(false); }, this.delay);
    } else this.emit({ enabled: true, phase: 'watching', message: `已自动保存 v${binding.revision} · 每 30 秒检查同事更新` });
  }
  private async execute(refresh: boolean): Promise<void> {
    const lifecycle = this.lifecycle;
    if (!this.status.enabled || !lifecycle || lifecycle.busy) return;
    lifecycle.busy = true;
    this.emit({ enabled: true, phase: refresh ? 'refreshing' : 'saving', message: refresh ? '正在检查同事更新…' : '正在自动保存…' });
    try {
      if (refresh) await refreshRecruitmentArchive(this.store, lifecycle.call, lifecycle.abort.signal);
      else await saveRecruitmentArchive(this.store, lifecycle.call, true, lifecycle.abort.signal);
    } catch (cause) {
      if (this.lifecycle === lifecycle && !lifecycle.abort.signal.aborted) {
        this.clear(); this.consent = undefined;
        this.emit({ enabled: false, phase: 'error', message: `自动保存已暂停：${cause instanceof Error ? cause.message : '档案同步失败'}。本地修改未丢弃。` });
      }
    } finally {
      lifecycle.busy = false;
      if (this.lifecycle === lifecycle) { if (this.status.enabled) this.changed(); else this.emit(this.status); }
    }
  }
}
const controllers = new WeakMap<RecruitmentWorkspaceStore, RecruitmentAutosave>();
export function getRecruitmentAutosave(store: RecruitmentWorkspaceStore): RecruitmentAutosave {
  let controller = controllers.get(store);
  if (!controller) { controller = new RecruitmentAutosave(store); controllers.set(store, controller); }
  return controller;
}
