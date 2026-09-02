/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设置与诊断中心 ·「设置」组面板：偏好设置 / MCP 服务器 / 扩展 / IDE 伴生。
 * 数据与动作全部来自 useSettingsData，本文件只负责排版。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { GeneratedIcon, type GeneratedIconName } from '../GeneratedIcon.js';
import { IconClose } from '../icons.js';
import { Panel, Card, Dot, Badge, Empty, type DotTone } from './HubUI.js';
import { readPetWidgetEnabled, writePetWidgetEnabled } from '../../petWidgetPreference.js';
import { announceRendererTheme } from '../../themeSync.js';

// ── 偏好设置 ──────────────────────────────────────────────────────────────

const AGENT_STYLES: Array<{ id: string; label: string; icon: GeneratedIconName }> = [
  { id: 'default', label: '日常对话（自然清晰）', icon: 'style-default' },
  { id: 'codex', label: '快速执行（少说多做）', icon: 'style-codex' },
  { id: 'cursor', label: '工作代码（协作开发）', icon: 'style-cursor' },
  { id: 'augment', label: '工程交付（任务与验证）', icon: 'style-augment' },
  { id: 'claude-code', label: '简洁开发（直接精炼）', icon: 'style-claude-code' },
  { id: 'antigravity', label: '企业办公（资料与会议）', icon: 'style-antigravity' },
  { id: 'windsurf', label: '协作推进（边讲边做）', icon: 'style-windsurf' },
];

const SIMPLE_AGENT_STYLES = [
  { id: 'default', label: '平时聊天', icon: 'style-default' as GeneratedIconName, hint: '自然、清楚，适合大多数事情' },
  { id: 'codex', label: '直接做事', icon: 'style-codex' as GeneratedIconName, hint: '少解释，优先把事情完成' },
  { id: 'augment', label: '复杂任务', icon: 'style-augment' as GeneratedIconName, hint: '先拆解，再执行和检查' },
];

/** 外观主题选项（nativeTheme.themeSource 三态）。 */
const THEME_OPTIONS: Array<{ id: 'system' | 'light' | 'dark'; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

export function PrefsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const s = state.settings;
  const [langDraft, setLangDraft] = useState('');
  // 外观主题：独立于 server settings（走 main 的 nativeTheme IPC，本机持久化）。
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  const [petWidgetEnabled, setPetWidgetEnabled] = useState(readPetWidgetEnabled);
  const [resetStatus, setResetStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [themeResetSettled, setThemeResetSettled] = useState(true);
  const resetErrorBaseline = useRef<string | null>(null);

  useEffect(() => {
    setLangDraft(s?.preferredLanguage ?? '');
  }, [s?.preferredLanguage]);

  useEffect(() => {
    let cancelled = false;
    void window.otto?.themeGet?.().then((v) => {
      if (!cancelled && v) setTheme(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickTheme = (v: 'system' | 'light' | 'dark'): void => {
    setTheme(v);
    announceRendererTheme(v);
    void window.otto?.themeSet?.(v);
  };

  useEffect(() => {
    if (resetStatus !== 'success') return;
    const timer = window.setTimeout(() => setResetStatus('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [resetStatus]);

  useEffect(() => {
    if (resetStatus !== 'pending') return;
    const timer = window.setTimeout(() => setResetStatus('error'), 8000);
    return () => window.clearTimeout(timer);
  }, [resetStatus]);

  useEffect(() => {
    if (
      resetStatus === 'pending' &&
      state.lastError &&
      state.lastError !== resetErrorBaseline.current
    ) {
      setResetStatus('error');
    }
  }, [resetStatus, state.lastError]);

  const preferencesAreDefault = Boolean(
    s &&
      theme === 'system' &&
      s.agentStyle === 'default' &&
      !petWidgetEnabled &&
      s.healthyUse === true &&
      (s.preferredLanguage ?? '') === '' &&
      langDraft === ''
  );
  const hasNonDefaultPreference = Boolean(s && !preferencesAreDefault);

  useEffect(() => {
    if (
      (resetStatus === 'pending' || resetStatus === 'error') &&
      themeResetSettled &&
      preferencesAreDefault
    ) {
      setResetStatus('success');
    }
  }, [preferencesAreDefault, resetStatus, themeResetSettled]);

  const resetPreferences = async (): Promise<void> => {
    if (
      !s ||
      resetStatus === 'pending' ||
      resetStatus === 'success' ||
      !hasNonDefaultPreference
    ) {
      return;
    }
    if (!window.confirm(
      '恢复外观与回复的默认设置？\n\n这会重置本页面的主题和回复偏好，不会影响账号、工作目录或其他设置。',
    )) return;

    resetErrorBaseline.current = state.lastError;
    setResetStatus('pending');
    const previousTheme = theme;
    const needsThemeReset = theme !== 'system';
    setThemeResetSettled(!needsThemeReset);
    try {
      let themeReset: Promise<unknown> | undefined;
      if (needsThemeReset) {
        setTheme('system');
        announceRendererTheme('system');
        themeReset = window.otto?.themeSet?.('system');
      }
      if (s.agentStyle !== 'default') actions.setSetting('agentStyle', 'default');
      if (s.healthyUse !== true) actions.setSetting('healthyUse', true);
      if ((s.preferredLanguage ?? '') !== '') {
        actions.setSetting('preferredLanguage', '');
      }
      if (petWidgetEnabled) {
        setPetWidgetEnabled(false);
        writePetWidgetEnabled(false);
      }
      setLangDraft('');
      await themeReset;
      setThemeResetSettled(true);
    } catch {
      // 主题 IPC 失败时恢复原来的视觉状态，并保留可重试入口。
      setTheme(previousTheme);
      announceRendererTheme(previousTheme);
      setThemeResetSettled(false);
      setResetStatus('error');
    }
  };

  const resetButtonLabel =
    resetStatus === 'pending'
      ? '正在恢复…'
      : resetStatus === 'success'
        ? '已恢复'
        : resetStatus === 'error'
          ? '恢复失败，重试'
          : '恢复默认设置';

  return (
    <Panel
      title="外观与回复"
      desc="只保留日常真正需要的选择；默认设置已经适合大多数人。"
      actions={(
        <button
          type="button"
          className="otto-hub__btn"
          disabled={
            !s ||
            resetStatus === 'pending' ||
            resetStatus === 'success' ||
            !hasNonDefaultPreference
          }
          onClick={() => { void resetPreferences(); }}
        >
          {resetButtonLabel}
        </button>
      )}
    >
      {!s ? (
        <Empty>正在加载偏好设置…</Empty>
      ) : (
        <>
        <Card className="otto-prefs-simple">
          <div className="otto-hub__setting otto-hub__setting--stack">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">外观</div>
              <div className="otto-hub__field-hint">
                选择你看着最舒服的界面。
              </div>
            </div>
            <div className="otto-hub__chiprow">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={'otto-hub__chip' + (theme === opt.id ? ' is-active' : '')}
                  onClick={() => pickTheme(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="otto-hub__setting otto-hub__setting--stack">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">希望 Otto 怎么帮你</div>
              <div className="otto-hub__field-hint">
                不需要理解模型参数，只选最接近你的习惯。
              </div>
            </div>
            <div className="otto-prefs-modes">
              {SIMPLE_AGENT_STYLES.map((style) => (
                <button
                  key={style.id}
                  type="button"
                  className={
                    'otto-hub__chip' + (s.agentStyle === style.id ? ' is-active' : '')
                  }
                  onClick={() => actions.setSetting('agentStyle', style.id)}
                >
                  <GeneratedIcon name={style.icon} size={18} />
                  <span><strong>{style.label}</strong><small>{style.hint}</small></span>
                </button>
              ))}
            </div>
          </div>
        </Card>

        <details className="otto-hub__details">
          <summary>更多偏好</summary>
          <Card>
          <div className="otto-hub__setting otto-hub__setting--stack">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">其他工作风格</div>
              <div className="otto-hub__field-hint">只有你明确知道自己想要哪种风格时才需要改。</div>
            </div>
            <div className="otto-hub__chiprow">
              {AGENT_STYLES.filter((style) => !SIMPLE_AGENT_STYLES.some((simple) => simple.id === style.id)).map((style) => (
                <button
                  key={style.id}
                  type="button"
                  className={'otto-hub__chip' + (s.agentStyle === style.id ? ' is-active' : '')}
                  onClick={() => actions.setSetting('agentStyle', style.id)}
                >
                  <GeneratedIcon name={style.icon} size={18} />
                  <span>{style.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="otto-hub__setting">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">小宠物挂件</div>
              <div className="otto-hub__field-hint">单击互动、双击打开 Otto、按住拖动；自动记住位置。</div>
            </div>
            <button
              type="button"
              className={'otto-hub__toggle' + (petWidgetEnabled ? ' is-on' : '')}
              onClick={() => {
                const next = !petWidgetEnabled;
                setPetWidgetEnabled(next);
                writePetWidgetEnabled(next);
              }}
              aria-pressed={petWidgetEnabled}
            >
              <span className="otto-hub__toggle-knob" />
              {petWidgetEnabled ? '已开启' : '已关闭'}
            </button>
          </div>

          <div className="otto-hub__setting">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">健康使用提醒</div>
              <div className="otto-hub__field-hint">深夜/长时间使用时收到善意提醒。</div>
            </div>
            <button
              type="button"
              className={'otto-hub__toggle' + (s.healthyUse ? ' is-on' : '')}
              onClick={() => actions.setSetting('healthyUse', !s.healthyUse)}
              aria-pressed={s.healthyUse}
            >
              <span className="otto-hub__toggle-knob" />
              {s.healthyUse ? '已开启' : '已关闭'}
            </button>
          </div>

          <div className="otto-hub__setting">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">偏好语言</div>
              <div className="otto-hub__field-hint">
                影响 Otto 回复所用的语言（留空 = 跟随对话自动判断）。
              </div>
            </div>
            <div className="otto-hub__inputrow otto-hub__inputrow--compact">
              <input
                className="otto-hub__input"
                type="text"
                value={langDraft}
                placeholder="例如：中文 / English"
                onChange={(e) => setLangDraft(e.target.value)}
              />
              <button
                type="button"
                className="otto-hub__btn"
                onClick={() => actions.setSetting('preferredLanguage', langDraft.trim())}
              >
                保存
              </button>
            </div>
          </div>

          <div className="otto-hub__setting">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">后台付费分析</div>
              <div className="otto-hub__field-hint">
                允许 Otto 在后台使用当前模型分析工作内容，可能产生 API 费用。新安装默认关闭，只有用户明确开启后才允许运行。
              </div>
            </div>
            <button
              type="button"
              aria-label="后台付费分析"
              className={'otto-hub__toggle' + (s.backgroundModelTasksEnabled ? ' is-on' : '')}
              onClick={() => actions.setSetting(
                'backgroundModelTasksEnabled',
                !s.backgroundModelTasksEnabled,
              )}
              aria-pressed={s.backgroundModelTasksEnabled}
            >
              <span className="otto-hub__toggle-knob" />
              {s.backgroundModelTasksEnabled ? '已开启' : '已关闭'}
            </button>
          </div>
          </Card>
        </details>
        </>
      )}
    </Panel>
  );
}

// ── MCP 服务器 ────────────────────────────────────────────────────────────

function mcpTone(status: 'connected' | 'connecting' | 'disconnected'): DotTone {
  return status === 'connected' ? 'on' : status === 'connecting' ? 'busy' : 'off';
}

const MCP_STATUS_LABEL: Record<'connected' | 'connecting' | 'disconnected', string> = {
  connected: '已连接',
  connecting: '连接中',
  disconnected: '未连接',
};

export function McpPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const [tab, setTab] = useState<'mine' | 'search' | 'create' | 'security'>('mine');
  const [query, setQuery] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftSource, setDraftSource] = useState('');
  const [inputKind, setInputKind] = useState<'natural_language' | 'openapi' | 'api_docs' | 'curl'>('natural_language');
  const [transportKind, setTransportKind] = useState<'stdio' | 'streamable_http'>('stdio');
  const [credentialServer, setCredentialServer] = useState('');
  const [credentialVariable, setCredentialVariable] = useState('');
  const [credentialValue, setCredentialValue] = useState('');
  const [credentialSummaries, setCredentialSummaries] = useState<Array<{ serverName: string; variableName: string; environmentAlias: string }>>([]);
  const [credentialMessage, setCredentialMessage] = useState('');
  const auditedCandidate = state.mcpAuditReport
    ? state.mcpSearchCandidates.find((candidate) => candidate.id === state.mcpAuditReport?.candidateId)
    : undefined;

  const createPreview = (): void => {
    if (!draftName.trim() || !draftDescription.trim() || !draftSource.trim()) return;
    actions.previewMcpCreation({
      name: draftName.trim(),
      description: draftDescription.trim(),
      inputKind,
      sourceText: draftSource,
      transport: transportKind,
    });
  };

  useEffect(() => {
    if (tab !== 'security' || !window.otto?.mcpCredentialList) return;
    void window.otto.mcpCredentialList().then(setCredentialSummaries).catch((error: unknown) => {
      setCredentialMessage(error instanceof Error ? error.message : String(error));
    });
  }, [tab]);

  const saveCredential = (): void => {
    if (!credentialServer.trim() || !credentialVariable.trim() || !credentialValue) return;
    setCredentialMessage('正在写入系统加密凭据库…');
    void window.otto.mcpCredentialSet({
      serverName: credentialServer.trim(),
      variableName: credentialVariable.trim().toUpperCase(),
      value: credentialValue,
    }).then(async () => {
      setCredentialValue('');
      setCredentialSummaries(await window.otto.mcpCredentialList());
      setCredentialMessage('凭据已加密保存；明文不会返回界面。');
    }).catch((error: unknown) => {
      setCredentialMessage(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <Panel
      title="MCP 服务器"
      desc="搜索、审计、创建和管理 MCP。搜索结果不会自动安装或执行。"
      actions={
        tab === 'mine' ? (
          <button type="button" className="otto-hub__btn" onClick={actions.refreshMcpServers}>
            刷新
          </button>
        ) : null
      }
    >
      <div className="otto-mcp__tabs" role="tablist" aria-label="MCP 管理">
        {([
          ['mine', '我的 MCP'],
          ['search', '搜索 MCP'],
          ['create', '创建 MCP'],
          ['security', '安全与权限'],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'mine' ? (
        state.mcpServers.length === 0 ? (
          <Empty>尚未安装 MCP。请先在「搜索 MCP」完成来源固定、审计和隔离试运行。</Empty>
        ) : (
          <Card>
            {state.mcpServers.map((s) => (
              <div key={s.name} className="otto-hub__item">
                <Dot tone={mcpTone(s.status)} />
                <span className="otto-hub__row-name">{s.name}</span>
                <span className="otto-hub__row-detail">{s.command ?? s.httpUrl ?? s.url ?? ''}</span>
                <Badge>{s.trust ? '旧配置已信任' : '默认不信任'}</Badge>
                <span className="otto-hub__row-status">{MCP_STATUS_LABEL[s.status]}</span>
                <button type="button" className="otto-hub__row-remove" onClick={() => actions.removeMcpServer(s.name)} aria-label={'移除 ' + s.name}>
                  <IconClose size={12} />
                </button>
              </div>
            ))}
          </Card>
        )
      ) : null}

      {tab === 'search' ? (
        <div className="otto-mcp__stack">
          <div className="otto-hub__inputrow">
            <input className="otto-hub__input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：只读查询 GitHub issue" />
            <button type="button" className="otto-hub__btn otto-hub__btn--primary" onClick={() => actions.searchMcpCatalog(query)} disabled={!query.trim()}>搜索官方 Registry</button>
          </div>
          <p className="otto-mcp__notice">官方 Registry 仅提供元数据且仍处于预览阶段；收录不等于 Otto 安全背书。</p>
          {state.mcpSearchCandidates.length === 0 ? <Empty>输入需求后搜索。任何结果都只会作为候选展示。</Empty> : (
            <div className="otto-mcp__cards">
              {state.mcpSearchCandidates.map((candidate) => (
                <Card key={candidate.id}>
                  <div className="otto-mcp__candidate-head"><strong>{candidate.title ?? candidate.name}</strong><Badge>{candidate.version}</Badge></div>
                  <p>{candidate.description}</p>
                  <dl className="otto-mcp__facts">
                    <div><dt>来源</dt><dd>{candidate.source === 'official_registry' ? '官方 MCP Registry' : 'GitHub 补充搜索'}</dd></div>
                    <div><dt>许可证</dt><dd>{candidate.license ?? '未验证'}</dd></div>
                    <div><dt>提交</dt><dd>{candidate.commitSha ?? '未固定'}</dd></div>
                    <div><dt>权限</dt><dd>{candidate.permissions.join('、')}</dd></div>
                    <div><dt>环境变量</dt><dd>{candidate.environmentVariables.map((item) => item.name).join('、') || '无声明'}</dd></div>
                  </dl>
                  <button type="button" className="otto-hub__btn" onClick={() => actions.auditMcpCandidate(candidate.id)}>检查许可证、固定版本与风险</button>
                </Card>
              ))}
            </div>
          )}
          {state.mcpAuditReport ? (
            <Card>
              <div className="otto-mcp__candidate-head"><strong>审计结果</strong><Badge>{state.mcpAuditReport.riskLevel}</Badge></div>
              {state.mcpAuditReport.checks.map((check) => <p key={check.id}><strong>{check.label}：</strong>{check.detail}（{check.status}）</p>)}
              <p className="otto-mcp__notice">当前未执行任何第三方代码。隔离测试只发送 initialize 与 tools/list，不调用任何工具。</p>
              <button
                type="button"
                className="otto-hub__btn"
                disabled={!state.mcpAuditReport.installable || !auditedCandidate?.remoteUrl || auditedCandidate.environmentVariables.some((item) => item.required)}
                onClick={() => actions.probeMcpCandidate(state.mcpAuditReport!.id)}
              >
                开始无凭据隔离列表测试
              </button>
              {!auditedCandidate?.remoteUrl ? <p className="otto-mcp__notice">该候选没有公开 Streamable HTTP 入口；本机进程型 MCP 在具备真正 OS 沙箱前不会下载或运行。</p> : null}
              {auditedCandidate?.environmentVariables.some((item) => item.required) ? <p className="otto-mcp__notice">该候选需要凭据；在系统加密凭据库完成配置前，不会试运行或安装。</p> : null}
              {state.mcpProbeResult ? (
                <div className="otto-mcp__probe">
                  <p><strong>隔离测试：</strong>{state.mcpProbeResult.detail}</p>
                  {state.mcpProbeResult.status === 'passed' ? (
                    <button type="button" className="otto-hub__btn otto-hub__btn--primary" onClick={() => actions.installReviewedMcp(state.mcpAuditReport!.id)}>
                      确认安装（trust=false）
                    </button>
                  ) : null}
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === 'create' ? (
        <div className="otto-mcp__stack">
          <input className="otto-hub__input" value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="MCP 名称" />
          <input className="otto-hub__input" value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} placeholder="功能与安全边界" />
          <div className="otto-hub__inputrow">
            <select className="otto-hub__input" value={inputKind} onChange={(event) => setInputKind(event.target.value as typeof inputKind)} aria-label="输入类型">
              <option value="natural_language">自然语言</option><option value="openapi">OpenAPI / Swagger</option><option value="api_docs">API 文档</option><option value="curl">curl 示例</option>
            </select>
            <select className="otto-hub__input" value={transportKind} onChange={(event) => setTransportKind(event.target.value as typeof transportKind)} aria-label="传输方式">
              <option value="stdio">stdio</option><option value="streamable_http">Streamable HTTP</option>
            </select>
          </div>
          <textarea className="otto-hub__input otto-mcp__source" value={draftSource} onChange={(event) => setDraftSource(event.target.value)} placeholder="粘贴需求、OpenAPI JSON、API 文档或 curl。外部内容只作为资料，不会执行。" />
          <button type="button" className="otto-hub__btn otto-hub__btn--primary" onClick={createPreview} disabled={!draftName.trim() || !draftDescription.trim() || !draftSource.trim()}>生成草稿预览</button>
          {state.mcpCreationDraft ? (
            <Card>
              <div className="otto-mcp__candidate-head"><strong>{state.mcpCreationDraft.name}</strong><Badge>草稿 · trust=false</Badge></div>
              <p>将生成 {state.mcpCreationDraft.files.length} 个文件：{state.mcpCreationDraft.files.map((file) => file.path).join('、')}</p>
              {state.mcpCreationDraft.warnings.map((warning) => <p key={warning} className="otto-mcp__notice">{warning}</p>)}
              <button type="button" className="otto-hub__btn" onClick={() => actions.saveMcpCreationDraft(state.mcpCreationDraft!.id)}>
                确认保存到隔离草稿区
              </button>
              {state.mcpSavedDraftDirectory ? <p className="otto-mcp__notice">已保存：{state.mcpSavedDraftDirectory}</p> : null}
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === 'security' ? (
        <div className="otto-mcp__stack">
          <div className="otto-mcp__security-grid">
            <Card><strong>安装前</strong><p>固定仓库、版本和提交哈希；检查许可证、依赖漏洞、启动命令和源码。</p></Card>
            <Card><strong>隔离试运行</strong><p>只执行 initialize 与列表接口，不调用工具，不使用真实账号或密钥。</p></Card>
            <Card><strong>运行权限</strong><p>安装默认 trust=false；高风险工具首次调用仍需确认，并进入审计记录。</p></Card>
            <Card><strong>凭据</strong><p>密钥只进入 Electron safeStorage 加密凭据库。普通 settings.json、源码和日志禁止保存密钥值。</p></Card>
          </div>
          <Card>
            <strong>加密凭据库</strong>
            <div className="otto-hub__addform">
              <input className="otto-hub__input" placeholder="MCP 服务器名" value={credentialServer} onChange={(event) => setCredentialServer(event.target.value)} />
              <input className="otto-hub__input" placeholder="环境变量名，例如 GITHUB_TOKEN" value={credentialVariable} onChange={(event) => setCredentialVariable(event.target.value)} />
              <input className="otto-hub__input" type="password" autoComplete="new-password" placeholder="密钥值（保存后立即从界面清除）" value={credentialValue} onChange={(event) => setCredentialValue(event.target.value)} />
              <button type="button" className="otto-hub__btn" onClick={saveCredential} disabled={!credentialServer.trim() || !credentialVariable.trim() || !credentialValue}>加密保存</button>
              {credentialMessage ? <p className="otto-mcp__notice">{credentialMessage}</p> : null}
            </div>
            {credentialSummaries.map((item) => (
              <div key={`${item.serverName}:${item.variableName}`} className="otto-hub__item">
                <span className="otto-hub__row-name">{item.serverName}</span>
                <span className="otto-hub__row-detail">{item.variableName}</span>
                <Badge>已加密</Badge>
                <button type="button" className="otto-hub__row-remove" aria-label={`删除 ${item.serverName} ${item.variableName}`} onClick={() => {
                  void window.otto.mcpCredentialRemove({ serverName: item.serverName, variableName: item.variableName }).then(async () => {
                    setCredentialSummaries(await window.otto.mcpCredentialList());
                  });
                }}><IconClose size={12} /></button>
              </div>
            ))}
          </Card>
        </div>
      ) : null}
    </Panel>
  );
}

// ── 扩展 ──────────────────────────────────────────────────────────────────

export function ExtensionsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;

  return (
    <Panel
      title="扩展"
      desc="已安装的扩展包及其版本。"
      actions={
        <button type="button" className="otto-hub__btn" onClick={actions.refreshExtensions}>
          刷新
        </button>
      }
    >
      {state.extensions.length === 0 ? (
        <Empty>尚未安装任何扩展。</Empty>
      ) : (
        <Card>
          {state.extensions.map((ext) => (
            <div key={ext.name} className="otto-hub__item">
              <span className="otto-hub__row-name">{ext.name}</span>
              <span className="otto-hub__row-detail">{ext.path}</span>
              <Badge>v{ext.version}</Badge>
            </div>
          ))}
        </Card>
      )}
    </Panel>
  );
}

// ── IDE 伴生 ──────────────────────────────────────────────────────────────

function ideTone(status: string): DotTone {
  return status === 'connected'
    ? 'on'
    : status === 'connecting'
      ? 'busy'
      : status === 'disconnected'
        ? 'err'
        : 'off';
}

const IDE_STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  disconnected: '未连接',
  not_applicable: '不适用',
};

export function IdePanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const s = state.ideStatus;

  return (
    <Panel
      title="IDE 伴生"
      desc="VS Code 伴生插件的连接状态。"
      actions={
        <button type="button" className="otto-hub__btn" onClick={actions.refreshIdeStatus}>
          刷新
        </button>
      }
    >
      {!s ? (
        <Empty>正在查询 IDE 伴生状态…</Empty>
      ) : (
        <Card>
          <div className="otto-hub__item">
            <Dot tone={ideTone(s.status)} />
            <span className="otto-hub__row-name">
              {IDE_STATUS_LABEL[s.status] ?? s.status}
            </span>
            {s.details ? <span className="otto-hub__row-detail">{s.details}</span> : null}
          </div>
        </Card>
      )}
    </Panel>
  );
}
