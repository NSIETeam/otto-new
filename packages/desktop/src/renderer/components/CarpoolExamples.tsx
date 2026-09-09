/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useState } from 'react';

const EXAMPLES = [
  { name: '顺路司机', percent: 95, mode: '可搭车 · 余 1 座', time: '18:20 出发', route: '园区南门 → 地铁站', detail: '大部分路段一致，适合在园区出口会合。' },
  { name: '一起叫车', percent: 86, mode: '一起叫车 · 2 人同行', time: '18:30 出发', route: '园区东门 → 商圈', detail: '主要方向一致，可协商共同上车点。' },
  { name: '同行小组', percent: 72, mode: '私家车 · 余 2 座', time: '18:40 出发', route: '园区南门 → 居住区', detail: '部分路段重合，需要进一步协商上下车地点。' },
] as const;

/** Local demonstration only: never enters real matching, messaging or metrics. */
export function CarpoolExamples(): React.JSX.Element {
  return (
    <section className="otto-carpool-examples" aria-label="同行示例体验">
      <header><h3>体验同行示例</h3><span>模拟人物与比例</span></header>
      <div className="otto-carpool-examples__grid">
        {EXAMPLES.map(example => <ExampleCard key={example.name} example={example} />)}
      </div>
    </section>
  );
}

function ExampleCard({ example }: { example: typeof EXAMPLES[number] }): React.JSX.Element {
  const [stage, setStage] = useState<'idle' | 'pending' | 'accepted'>('idle');
  return (
    <article className="otto-carpool-examples__card">
      <header><strong>{example.name}</strong><span className="otto-carpool-examples__badge">示例</span></header>
      <div className="otto-carpool-examples__score"><strong>{example.percent}%</strong><span>同路 · 示例值</span></div>
      <progress max={100} value={example.percent} aria-label={`${example.name}示例同路比例`} />
      <p>{example.mode}</p>
      <p>{example.time}</p>
      <details><summary>查看示例行程</summary><p>{example.route}</p><p>{example.detail}</p></details>
      {stage === 'idle' ? <button type="button" onClick={() => setStage('pending')}>体验联系</button> : <>
        <p role="status">{stage === 'pending' ? '示例请求已发送 · 等待回应' : '示例对方已接受 · 可以协商同行'}</p>
        {stage === 'pending' ? <button type="button" onClick={() => setStage('accepted')}>模拟对方接受</button> : null}
        <button type="button" onClick={() => setStage('idle')}>重新体验</button>
      </>}
    </article>
  );
}
