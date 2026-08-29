/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useEffect, useId, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

import {
  getModuleGroupTemplateInstallState,
  installModuleGroupTemplate,
  listModuleGroupTemplates,
} from '../moduleGroupCatalog.js';
import type { ModuleDefinition } from '../moduleCatalog.js';
import { createModuleGroup, type ModuleWorkspaceEdition, type ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import { ModuleIcon } from './ModuleIcon.js';

export interface ModuleGroupCatalogDialogProps {
  open: boolean;
  edition: ModuleWorkspaceEdition;
  layout: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  onConfirm(next: ModuleWorkspaceLayout): void;
  onClose(): void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden'));
}

export function ModuleGroupCatalogDialog({
  open,
  edition,
  layout,
  modules,
  onConfirm,
  onClose,
}: ModuleGroupCatalogDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const titleId = `${useId()}-title`;
  const templates = useMemo(() => listModuleGroupTemplates(edition), [edition]);
  const modulesById = useMemo(
    () => new Map(modules.map((module) => [module.id, module])),
    [modules],
  );

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeRef.current?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  if (!open) return null;

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
        className="otto-module-marketplace otto-module-group-catalog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="otto-module-marketplace__header">
          <div>
            <h2 id={titleId}>新增功能组</h2>
            <p>选择官方模板一次装入整组功能，或从空白组开始自定义。</p>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭新增功能组" onClick={onClose}>×</button>
        </header>

        <div className="otto-module-group-catalog__body">
          <section aria-labelledby={`${titleId}-official`}>
            <div className="otto-module-group-catalog__section-head">
              <div>
                <h3 id={`${titleId}-official`}>官方功能组</h3>
                <p>由 Otto 维护并随版本持续更新。</p>
              </div>
              <span>OTTO OFFICIAL</span>
            </div>
            <div className="otto-module-group-catalog__templates">
              {templates.map((template) => {
                const installState = getModuleGroupTemplateInstallState(layout, template);
                const templateModules = template.moduleIds.map((moduleId) => modulesById.get(moduleId));
                const unavailableCount = templateModules.filter((module) => (
                  module?.availability !== 'available'
                )).length;
                return (
                  <article key={template.package.packageId} className="otto-module-group-template">
                    <div className="otto-module-group-template__lead">
                      <ModuleIcon icon={template.icon} label={template.name} size={34} />
                      <div>
                        <div className="otto-module-group-template__title-row">
                          <h4>{template.name}</h4>
                          <span>v{template.package.version}</span>
                        </div>
                        <p>{template.description}</p>
                      </div>
                    </div>
                    <div className="otto-module-group-template__modules" aria-label={`${template.name}包含的模块`}>
                      {templateModules.map((module, index) => (
                        <span
                          key={template.moduleIds[index]}
                          className={module?.availability === 'available' ? '' : 'is-unavailable'}
                          title={module?.disabledReason}
                        >
                          {module?.label ?? template.moduleIds[index]}
                        </span>
                      ))}
                    </div>
                    <div className="otto-module-group-template__footer">
                      <small>
                        {template.moduleIds.length} 个功能
                        {unavailableCount > 0 ? ` · ${unavailableCount} 个将在企业启用对应服务后可用` : ' · 当前均可用'}
                      </small>
                      <button
                        type="button"
                        disabled={installState === 'installed'}
                        onClick={() => {
                          onConfirm(installModuleGroupTemplate(layout, template));
                          onClose();
                        }}
                      >
                        {installState === 'installed'
                          ? '已添加'
                          : installState === 'update'
                            ? '升级功能组'
                            : '添加功能组'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section aria-labelledby={`${titleId}-custom`}>
            <div className="otto-module-group-catalog__section-head">
              <div>
                <h3 id={`${titleId}-custom`}>自定义功能组</h3>
                <p>创建空白组，再从模块目录自由组合。</p>
              </div>
            </div>
            <button
              type="button"
              className="otto-module-group-catalog__custom"
              onClick={() => {
                onConfirm(createModuleGroup(layout));
                onClose();
              }}
            >
              <span aria-hidden>＋</span>
              <strong>创建空白功能组</strong>
              <small>来源：本地用户 · 后续可加入自建组件</small>
            </button>
          </section>

          <p className="otto-module-group-catalog__developer-note">
            开发者组件接入已预留来源、发布者、包标识和版本协议；当前仅开放 Otto 官方组件与本地自定义编排。
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
