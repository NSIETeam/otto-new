/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import {expect,it} from 'vitest';
import {readCarpoolConfig} from './parkCarpoolConfig.js';
it('validates independent rollout flags and bounded request/capacity settings',()=>{
 expect(readCarpoolConfig({OTTO_PARK_CARPOOL_GROUPS_ENABLED:'false',OTTO_PARK_CARPOOL_MAX_TAXI_MEMBERS:'3',OTTO_PARK_CARPOOL_REQUEST_LIMIT_PER_HOUR:'6'})).toMatchObject({groupsEnabled:false,invitationsEnabled:true,maxTaxiMembers:3,requestLimitPerHour:6});
 for(const env of [{OTTO_PARK_CARPOOL_MAX_TAXI_MEMBERS:'4.5'},{OTTO_PARK_CARPOOL_REQUEST_LIMIT_PER_HOUR:'0'},{OTTO_PARK_CARPOOL_GROUPS_ENABLED:'yes'},{OTTO_PARK_CARPOOL_STALE_MINUTES:'120',OTTO_PARK_CARPOOL_PAUSE_MINUTES:'60'}])expect(()=>readCarpoolConfig(env)).toThrow(/配置无效/);
});
