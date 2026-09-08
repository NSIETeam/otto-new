/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useState } from 'react';
import type { RecruitmentOneOffAction } from 'otto-server';

export function RecruitmentOneOffAnalysis({ request, modelId, savedJob, disabled, onRun }: {
  request?: RecruitmentOneOffAction; modelId?: string; disabled: boolean;
  savedJob?: { title: string; description: string };
  onRun(action: RecruitmentOneOffAction): Promise<void>;
}) {
  const [approved, setApproved] = useState('');
  // Approval is bound to exactly what was displayed, not a boolean carried to a new job/model/revision.
  const key = JSON.stringify([request, modelId, savedJob]);
  return <details>
    <summary>用企业模型分析这一份</summary>
    {!request || !modelId ? <p>请岗位创建者先保存企业模型与岗位额度，可选择“保存额度，不开启后台”。</p> : <>
      <p>模型：{modelId}。只读取这份已在服务器保存的简历和当前岗位要求；与后台分析共用岗位、企业额度和防重复记录。</p>
      {savedJob ? <div><p>服务器已保存岗位：{savedJob.title}</p><p>{savedJob.description}</p><p>不会使用尚未保存的本地岗位修改；如需采用新要求，请先保存岗位并重新确认。</p></div> : null}
      <p>不会开启后台任务，不会上传本地文件或使用企业记忆、面试材料。结果沿用待处理期限，向本岗位授权同事共享；如已另行开启自动入档，将按该授权继续入档。</p>
      <label><input type="checkbox" checked={approved === key} disabled={disabled} onChange={(event) => setApproved(event.target.checked ? key : '')} />我确认本份简历可发送给上述企业模型，接受本次费用及限期共享结果</label>
      <button type="button" disabled={disabled || approved !== key} onClick={() => { setApproved(''); void onRun(request); }}>只分析这一份（企业模型）</button>
      <p>最多等待约两分钟。断网或关闭窗口不能保证撤销已发出的请求；请刷新查看原结果，不会自动改用桌面模型或重试。</p>
    </>}
  </details>;
}
