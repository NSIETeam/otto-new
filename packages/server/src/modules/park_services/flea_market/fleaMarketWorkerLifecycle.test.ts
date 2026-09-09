import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMarketApplication} from './fleaMarketApplication.js';
import {createEncryptedObjectStore} from '../../data_platform/index.js';
import {sqliteMarketHarness,postgresMarketHarness,marketServiceFixture} from './fleaMarketTestSupport.js';
for(const [backend,harness] of [['sqlite',sqliteMarketHarness],['postgres',postgresMarketHarness]] as const){
 it(`${backend}: worker restarts are idempotent and obsolete stop callbacks cannot close a newer lifecycle`,async()=>{
  const h=await harness();const root=mkdtempSync(join(tmpdir(),'market-worker-'));
  try{
   const base=await marketServiceFixture(h.repository);
   const app=createMarketApplication({...base,localAcceptance:false,objects:createEncryptedObjectStore({root,keyProvider:{getKey:()=>Buffer.alloc(32,17),clear(){}}})});
   let registrations=0; let stops=0;
   const registry={register:()=>{registrations++;return()=>{stops++;};}};
   const stop=app.start(registry as never);expect(app.start(registry as never)).toBe(stop);
   await app.initialize();expect(app.readiness().ready).toBe(true);expect(registrations).toBe(1);
   stop();expect(app.readiness().ready).toBe(false);expect(stops).toBe(1);
   const next=app.start(registry as never);await app.initialize();expect(app.readiness().ready).toBe(true);
   stop();expect(app.readiness().ready).toBe(true);expect(stops).toBe(1);
   next();expect(stops).toBe(2);expect(app.readiness().ready).toBe(false);
   expect(()=>app.start({register:()=>{throw new Error('registration failed');}} as never)).toThrow('registration failed');
   await app.initialize();expect(app.readiness().ready).toBe(false);
  }finally{await h.close();rmSync(root,{recursive:true});}
 },30000);
}
