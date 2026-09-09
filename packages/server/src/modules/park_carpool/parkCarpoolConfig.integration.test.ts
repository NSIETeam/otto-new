/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import {expect, it, vi} from 'vitest';
import {carpoolTestConfig, sqliteHarness, postgresHarness, fixed, publish} from './parkCarpoolTestSupport.js';
import {createParkCarpoolService} from './parkCarpoolService.js';
import {readCarpoolConfig, carpoolCommunicationCapabilities} from './parkCarpoolConfig.js';
for (const [name, factory] of [['SQLite', sqliteHarness], ['PostgreSQL', postgresHarness]] as const) {
 it.skipIf(name === 'PostgreSQL' && process.env.OTTO_CARPOOL_POSTGRES_TEST !== '1')(`${name}: injected rollout snapshot survives env drift and restart preserves historical management`, async () => {
  const h = await factory();
  const provider = {configured: true, searchPlaces: async () => [], planDrivingRoute: async (a: {longitude:number;latitude:number}, b: {longitude:number;latitude:number}) => ({provider:'synthetic', distanceMeters:8500,durationSeconds:1200,polyline:[a,b]})};
  const make = (config = carpoolTestConfig, map = provider) => createParkCarpoolService({config, store:h.store, now:()=>fixed, createId:id=>`intent-${id}`, mapProvider:map});
  try {
   const enabled = make();
   vi.stubEnv('OTTO_PARK_CARPOOL_REQUESTS_ENABLED','false');
   await enabled.publishIntent('a',publish); await enabled.publishIntent('b',publish);
   expect((await enabled.getState('a')).capabilities).toEqual(carpoolCommunicationCapabilities(carpoolTestConfig));
   await enabled.executeWorkflow('a',{type:'request',kind:'text',targetIntentId:'intent-b',firstMessage:'公共集合点见'});
   const req=(await enabled.getWorkflow('b')).requests[0]!;
   await enabled.executeWorkflow('b',{type:'resolve',requestId:req.id,action:'accept'});
   const history=(await enabled.getWorkflow('a')).conversations;
   expect(history).toHaveLength(1);
   const paused=make(readCarpoolConfig({}), {...provider,configured:false});
   expect((await paused.getState('a')).capabilities).toEqual([]);
   expect((await paused.getState('a')).matches).toHaveLength(0);
   await expect(paused.routePreview('a','intent-b')).rejects.toThrow(/无权/);
   expect((await paused.getWorkflow('a')).capabilities).toEqual([]);
   expect((await paused.getWorkflow('a')).conversations).toEqual(history);
   expect((await paused.getState('a')).availability?.canPublish).toBe(false);
   await expect(paused.publishIntent('a',{...publish,requestKey:'new'})).rejects.toThrow(/暂停/);
   expect((await paused.stopIntent('a','intent-a')).status).toBe('paused');
   const pilot=make(readCarpoolConfig({OTTO_PARK_CARPOOL_REQUESTS_ENABLED:'true',OTTO_PARK_CARPOOL_PILOT_PARK_IDS:'another-park'}));
   expect((await pilot.getWorkflow('a')).capabilities).toEqual([]);
   await expect(pilot.publishIntent('a',{...publish,requestKey:'pilot'})).rejects.toThrow(/暂停/);
   expect((await pilot.getWorkflow('a')).conversations).toEqual(history);
  } finally {vi.unstubAllEnvs();await h.close();}
 });
}
