/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ModuleCategory, ModuleDefinition } from '../moduleCatalog.js';
import { type ModuleWorkspaceLayout, updateGroupModuleSelection } from '../moduleWorkspace.js';
import { ModuleIcon } from './ModuleIcon.js';

const CATEGORY_LABELS: Readonly<Record<ModuleCategory, string>> = {
  common: '常用',
  park: '园区服务',
  recruitment: '智能招聘',
  capability: '企业能力',
  'custom-agent': '我的专家',
  'customer-module': '客户模块',
};

const CATEGORY_ORDER: readonly ModuleCategory[] = [
  'common',
  'recruitment',
  'capability',
  'custom-agent',
  'customer-module',
];

export interface ModuleMarketplaceDialogProps {
  open: boolean;
  targetGroupId: string;
  layout: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  onConfirm(next: ModuleWorkspaceLayout): void;
  onClose(): void;
  onManageExperts(): void;
  onDeleteExpert?(id: string): void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden'));
}

export function ModuleMarketplaceDialog({
  open,
  targetGroupId,
  layout,
  modules,
  onConfirm,
  onClose,
  onManageExperts,
  onDeleteExpert,
}: ModuleMarketplaceDialogProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const selectionTargetRef = useRef('');
  const titleId = `${useId()}-title`;
  const targetGroup = layout.groups.find((group) => group.id === targetGroupId);

  useEffect(() => {
    if (open && (!wasOpenRef.current || selectionTargetRef.current !== targetGroupId)) {
      triggerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      selectionTargetRef.current = targetGroupId;
      setQuery('');
      setSelection(new Set(targetGroup?.moduleIds ?? []));
      setActionError('');
      closeRef.current?.focus();
    }
    if (!open && wasOpenRef.current) {
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    }
    wasOpenRef.current = open;
  }, [open, targetGroup, targetGroupId]);

  const moduleIdSignature = modules.map((module) => module.id).join('\u0000');
  useEffect(() => {
    if (!open) return;
    const validModuleIds = new Set(modules.map((module) => module.id));
    setSelection((current) => {
      const next = new Set([...current].filter((moduleId) => validModuleIds.has(moduleId)));
      return next.size === current.size ? current : next;
    });
  }, [moduleIdSignature, modules, open]);

  const moduleLocation = useMemo(() => {
    const result = new Map<string, { groupId: string; groupName: string }>();
    for (const group of layout.groups) {
      for (const moduleId of group.moduleIds) {
        result.set(moduleId, { groupId: group.id, groupName: group.name });
      }
    }
    return result;
  }, [layout]);

  const visibleModules = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return modules.filter((module) => {
      if (module.category === 'park') return false;
      if (module.availability === 'hidden') return false;
      if (!normalizedQuery) return true;
      return `${module.label} ${module.description ?? ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [modules, query]);

  if (!open || !targetGroup) return null;

  const currentSelection = new Set(targetGroup.moduleIds);
  const addedCount = [...selection].filter((moduleId) => !currentSelection.has(moduleId)).length;
  const removedCount = targetGroup.moduleIds.filter((moduleId) => !selection.has(moduleId)).length;
  const hasChanges = addedCount > 0 || removedCount > 0;
  const changeSummary = [
    addedCount > 0 ? `添加 ${addedCount}` : '',
    removedCount > 0 ? `移除 ${removedCount}` : '',
  ].filter(Boolean).join('，');

  const toggleSelection = (moduleId: string): void => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="otto-module-marketplace-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="otto-module-marketplace"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="otto-module-marketplace__header">
          <div>
            <h2 id={titleId}>管理模块</h2>
            <p>勾选要放入“{targetGroup.name}”的模块；取消勾选即可移除</p>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭模块管理" onClick={onClose}>×</button>
        </header>
        <label className="otto-module-marketplace__search">
          <span className="sr-only">搜索模块</span>
          <input
            type="search"
            aria-label="搜索模块"
            placeholder="搜索模块……"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="otto-module-marketplace__catalog">
          {CATEGORY_ORDER.map((category) => {
            const categoryModules = visibleModules.filter((module) => module.category === category);
            if (categoryModules.length === 0) return null;
            return (
              <section key={category} className="otto-module-marketplace__category">
                <h3>{CATEGORY_LABELS[category]}</h3>
                <div className="otto-module-marketplace__modules">
                  {categoryModules.map((module) => {
                    const location = moduleLocation.get(module.id);
                    const inTargetGroup = location?.groupId === targetGroup.id;
                    const unavailable = module.availability !== 'available';
                    const disabled = unavailable && !inTargetGroup;
                    const selected = selection.has(module.id);
                    const customAgentId = module.activation.kind === 'agent'
                      ? module.activation.customAgentId
                      : undefined;
                    return (
                      <div key={module.id} className="otto-module-marketplace__module-wrap">
                        <label
                          className={`otto-module-marketplace__module${disabled ? ' is-disabled' : ''}${customAgentId && onDeleteExpert ? ' has-delete-action' : ''}${!selected && inTargetGroup ? ' is-removing' : ''}`}
                        >
                          <input
                            type="checkbox"
                            aria-label={module.label}
                            checked={selected}
                            disabled={disabled}
                            onChange={() => toggleSelection(module.id)}
                          />
                          <ModuleIcon icon={module.icon} label={module.label} size={26} />
                          <span className="otto-module-marketplace__module-copy">
                            <strong>{module.label}</strong>
                            <small>
                              {inTargetGroup
                                ? selected
                                  ? '已添加；取消勾选可移除'
                                  : '保存后从当前功能组移除'
                                : unavailable
                                  ? module.disabledReason ?? '当前不可用'
                                  : location
                                    ? `将从“${location.groupName}”移动`
                                    : module.description ?? '可添加到当前功能组'}
                            </small>
                          </span>
                        </label>
                        {customAgentId && onDeleteExpert ? (
                          <button
                            type="button"
                            className="otto-module-marketplace__delete"
                            aria-label={`删除专家 ${module.label}`}
                            title="永久删除这个专家"
                            onClick={() => {
                              if (!window.confirm(
                                `永久删除专家“${module.label}”？删除后会同时从所有功能组移除。`,
                              )) return;
                              setActionError('');
                              try {
                                onDeleteExpert(customAgentId);
                              } catch (cause) {
                                setActionError(cause instanceof Error ? cause.message : String(cause));
                              }
                            }}
                          >
                            删除
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {visibleModules.length === 0 ? (
            <p className="otto-module-marketplace__empty">没有找到匹配的模块</p>
          ) : null}
        </div>
        {actionError ? (
          <p role="alert" className="otto-module-marketplace__error">{actionError}</p>
        ) : null}
        <footer className="otto-module-marketplace__footer">
          <button type="button" className="otto-module-marketplace__manage" onClick={onManageExperts}>
            管理/删除我的专家
          </button>
          <button
            type="button"
            className="otto-module-marketplace__confirm"
            disabled={!hasChanges}
            onClick={() => {
              onConfirm(updateGroupModuleSelection(layout, targetGroupId, [...selection]));
              onClose();
            }}
          >
            保存更改{changeSummary ? `（${changeSummary}）` : ''}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
