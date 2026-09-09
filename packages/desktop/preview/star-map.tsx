/** Local acceptance harness: renders the actual production star-map component. */
import React from 'react';
import { StarMapPerformance } from './star-map-performance.js';
import { createRoot } from 'react-dom/client';
import { EnterpriseStarMapView } from '../src/renderer/components/EnterpriseStarMapView.js';
window.otto = {
  enterpriseParkStarMap: async()=>{throw new Error('本预览仅提供公开资料演示，真实园区请从应用进入。');},
  onEnterpriseSessionInvalidated: ()=>()=>undefined,
  openExternal: async(url:string)=>{window.open(url,'_blank','noopener,noreferrer');},
  writeClipboard: async(text:string)=>{await navigator.clipboard.writeText(text);return true;},
} as unknown as Window['otto'];
document.body.style.cssText='margin:0;background:#fcfbfe;font-family:Inter,system-ui,sans-serif';
const host=document.createElement('div');host.style.cssText='height:100vh;width:100vw';document.body.append(host);
createRoot(host).render(<React.StrictMode>{new URLSearchParams(location.search).has('count') ? <StarMapPerformance/> : <EnterpriseStarMapView initialSource="demo" onBack={()=>window.history.back()}/>}</React.StrictMode>);
