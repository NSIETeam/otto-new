/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React from 'react';
import type { CandidateWorkspace } from '../recruitmentWorkspaceStore.js';

export function RecruitmentMaterialEvidence({ candidate }: { candidate: CandidateWorkspace }): React.JSX.Element | null {
  const current = candidate.sourceMaterial;
  if (!current) return null;
  const status = current.material.completeness === 'full_text' ? '来源已提供完整正文'
    : current.material.completeness === 'partial' ? '仅有部分资料，非完整简历' : '尚未取得正文';
  return <section className="otto-recruitment-panel" aria-label="来源材料与版本">
    <header><div><strong>来源材料与版本</strong><span>{current.source.sourceLabel} · {status}</span></div></header>
    {current.material.reason ? <p role="status">{current.material.reason}</p> : null}
    {current.material.attachment ? <div>
      <p>附件核对：{current.material.attachment.format.toUpperCase()} · {current.material.attachment.bytes} 字节{current.material.attachment.pages ? ` · ${current.material.attachment.pages} 页` : ''} · {current.material.attachment.extractorVersion}</p>
      <p style={{ overflowWrap: 'anywhere' }}>文件 SHA-256：{current.material.attachment.sha256}</p>
      <p>当前保留的是提取文字与文件校验信息，原始附件尚未托管；如需保存原件，请从授权来源另行留存。</p>
    </div> : null}
    <p>获取时间：{new Date(current.retrievedAt).toLocaleString('zh-CN')}。材料不会自动上传；请查看“企业共享岗位”的保存状态，未保存的修改关闭应用后可能丢失。</p>
    {current.material.text ? <details><summary>查看来源正文</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{current.material.text}</pre></details> : <p>来源未提供可分析文字；没有用摘要冒充全文。</p>}
    {(candidate.sourceHistory ?? []).map((version, index) => <details key={`${version.material.retrievedAt}:${index}`}>
      <summary>历史版本 {candidate.sourceHistory!.length - index} · {new Date(version.material.retrievedAt).toLocaleString('zh-CN')}</summary>
      <p>当时的分析：{version.evaluation?.summary ?? '该版本未完成全文分析'}</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{version.material.material.text || '未取得正文'}</pre>
    </details>)}
  </section>;
}
