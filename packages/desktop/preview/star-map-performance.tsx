/** Explicit synthetic acceptance harness. Never supplies data to production services. */
import React,{useMemo,useState,useCallback} from 'react';
import { EnterpriseGraphCanvas,type GraphMetrics } from '../src/renderer/starMap/EnterpriseGraphCanvas.js';
import { demoMap,graphIndex } from '../src/renderer/starMap/model.js';
export function StarMapPerformance():React.JSX.Element{
 const count=Math.min(1000,Math.max(1,Number(new URLSearchParams(location.search).get('count'))||300));
 const [metrics,setMetrics]=useState<GraphMetrics|null>(null);
 const [selected,setSelected]=useState<string|null>(null);const [hover,setHover]=useState<string|null>(null);
 const [mounted,setMounted]=useState(true);const [round,setRound]=useState(1);
 const [idle,setIdle]=useState('尚未检查');
 const index=useMemo(()=>{
  const nodes=Array.from({length:count},(_,i)=>({...demoMap.nodes[0],organizationId:`synthetic-${i}`,organizationName:`性能测试企业${i}`,displayName:`测试企业${i}`}));
  return graphIndex({...demoMap,nodes,industryGroups:[{code:'test',name:'合成测试行业',memberOrganizationIds:nodes.map(n=>n.organizationId)}]});
 },[count]);
 const record=useCallback((next:GraphMetrics)=>setMetrics(next),[]);
 return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
  <header style={{padding:12,fontSize:12}}><strong>仅用于验收的合成数据 · {count} 家 / {count*(count-1)/2} 对业务关系</strong>
   <button onClick={()=>{setMounted(value=>!value);setRound(value=>value+1);}}>关闭 / 重开画布</button><span>操作轮次 {round}</span>
   <button onClick={()=>{const canvas=document.querySelector<HTMLElement>('[data-render-frames]');const before=canvas?.dataset.renderFrames;setIdle('检查中');setTimeout(()=>setIdle(`5秒新增绘制帧：${Number(canvas?.dataset.renderFrames??0)-Number(before??0)}`),5000);}}>检查稳定后空闲绘制</button>
   <output aria-label="性能测量">{metrics?JSON.stringify(metrics):'正在布局'}</output><output>{idle}</output>
  </header><div style={{flex:1,position:'relative'}}>{mounted?<EnterpriseGraphCanvas key={round} index={index} ownId="" selected={selected} hover={hover} scope={null} matches={new Set()} sizeMode="uniform" reducedMotion={false} showIndustries onSelect={setSelected} onHover={setHover} onMetrics={record}/>:<p>画布已卸载</p>}</div>
 </div>;
}
