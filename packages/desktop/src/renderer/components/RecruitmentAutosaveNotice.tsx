/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useSyncExternalStore } from 'react';
import { getRecruitmentAutosave } from '../recruitmentAutosave.js';
import type { RecruitmentWorkspaceStore } from '../recruitmentWorkspaceStore.js';

/** Errors remain visible when the recruitment dialog is closed. No candidate PII in the notice. */
export function RecruitmentAutosaveNotice({ store, hidden, onOpen }: { store: RecruitmentWorkspaceStore; hidden: boolean; onOpen: () => void }): React.JSX.Element | null {
  const controller = getRecruitmentAutosave(store);
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (hidden || status.phase !== 'error') return null;
  return <div className="otto-toast" role="alert"><span className="otto-toast__msg">招聘档案自动保存已暂停。本地修改仍在，请打开招聘工作台处理后再关闭 Otto。</span><button type="button" onClick={onOpen}>打开招聘工作台</button></div>;
}
