/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import * as db from './db.js';
import { handleParkCarpoolHttp, type ParkCarpoolHttpDeps } from '../modules/park_carpool/parkCarpoolHttp.js';

export type ParkCarpoolRouteDeps = Omit<ParkCarpoolHttpDeps, 'service'>;
export function handleParkCarpoolRoute(input: ParkCarpoolRouteDeps): Promise<boolean> {
  return handleParkCarpoolHttp({ ...input, service: {
    executeSignedTransport: db.executeSignedParkCarpoolTransport,
    executeTransport: db.executeParkCarpoolTransport,
    maintain: db.maintainParkCarpool,
    deleteData: db.deleteParkCarpoolData,
    routePreview: db.getParkCarpoolRoutePreview,
    reversePlace: db.reverseParkCarpoolPlace,
    staticMap: db.getParkCarpoolStaticMap,
    getWorkflow: db.getParkCarpoolWorkflow,
    executeWorkflow: db.executeParkCarpoolWorkflow,
    getState: db.getParkCarpoolState,
    refreshMatches: db.refreshParkCarpoolMatches,
    searchPlaces: db.searchParkCarpoolPlaces,
    publishIntent: db.publishParkCarpoolIntent,
    stopIntent: db.stopParkCarpoolIntent,
    confirmIntent: db.confirmParkCarpoolIntent,
  } });
}
