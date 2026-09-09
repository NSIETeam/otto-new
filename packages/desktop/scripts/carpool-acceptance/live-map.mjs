/** Authorized live provider probe. Public Hangzhou landmarks only; never writes raw addresses or keys. */
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { createAmapParkCarpoolProvider } from '../../../server/dist/src/modules/park_carpool/amapParkCarpoolProvider.js';
import { planCarpoolDetour } from '../../../server/dist/src/modules/park_carpool/parkCarpoolGroupMatching.js';
const key = process.env.OTTO_AMAP_WEB_SERVICE_KEY;
if (!key) {
  console.log(
    JSON.stringify({
      status: 'external_blocked',
      missing: 'OTTO_AMAP_WEB_SERVICE_KEY',
      liveProviderExecuted: false,
    }),
  );
  process.exit(2);
}
const provider = createAmapParkCarpoolProvider({ key });
try {
  const origins = await provider.searchPlaces('杭州市民中心', '杭州');
  const destinations = await provider.searchPlaces('江陵路地铁站', '杭州');
  assert(origins.length > 0 && destinations.length > 0, 'public POI search');
  // Public landmark selection is explicit and auditable, never a residential address.
  const origin = origins.find((p) => p.label.includes('市民中心'));
  const destination = destinations.find((p) => p.label.includes('江陵路'));
  assert(origin && destination, 'expected public landmark names');
  const reverse = await provider.reverseGeocode(origin.coordinate, 'autonavi');
  assert(
    reverse.publicArea?.code && reverse.publicArea.precision === 'district',
  );
  const route = await provider.planDrivingRoute(
    origin.coordinate,
    destination.coordinate,
  );
  assert(
    route.polyline.length >= 2 &&
      route.distanceMeters > 0 &&
      route.durationSeconds > 0,
  );
  const map = await provider.staticMap(origin.coordinate, 14);
  assert(/^data:image\/(png|jpeg);base64,/.test(map));
  // The chosen public approximate WGS84 point exercises conversion independently of OS geolocation.
  const converted = await provider.reverseGeocode(
    { longitude: 120.207, latitude: 30.247 },
    'gps',
  );
  assert(Number.isFinite(converted.coordinate.longitude));
  const detour = await planCarpoolDetour(
    { travelMode: 'shared_taxi', coordinatorAccountId: 'public-a' },
    [{ accountId: 'public-a', origin, destination, route }],
    { accountId: 'public-b', origin, destination, route },
    provider,
  );
  assert(
    detour.perMember.length === 2 &&
      Number.isFinite(detour.maximumDetourSeconds),
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      provider: 'amap',
      city: 'Hangzhou',
      search: true,
      reverse: true,
      staticMap: true,
      gpsConversion: true,
      route: {
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        pointCount: route.polyline.length,
      },
      osLocationPermission: false,
      groupDetourLive: true,
      maximumDetourSeconds: detour.maximumDetourSeconds,
    }),
  );
} catch {
  console.log(
    JSON.stringify({
      status: 'failed',
      reason:
        'Live public-landmark provider contract failed; inspect locally without recording credentials',
      liveProviderExecuted: true,
    }),
  );
  process.exitCode = 1;
}
