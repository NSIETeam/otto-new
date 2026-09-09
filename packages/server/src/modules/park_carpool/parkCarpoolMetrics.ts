/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export interface CarpoolMeasurement {
  accountId: string;
  day: string;
  opened: boolean;
  published: boolean;
  matched: boolean;
  candidateSamples: number;
  candidateTotal: number;
  routeViews: number;
  mapCalls: number;
  mapFailures: number;
  mapMilliseconds: number;
  maximumGroupSize: number;
}
export function carpoolMeasurement(
  state: { measurements?: CarpoolMeasurement[] },
  accountId: string,
  now: string,
): CarpoolMeasurement {
  const day = new Date(Date.parse(now) + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  const records = (state.measurements ??= []);
  let record = records.find(
    (row) => row.accountId === accountId && row.day === day,
  );
  if (!record) {
    record = {
      accountId,
      day,
      opened: false,
      published: false,
      matched: false,
      candidateSamples: 0,
      candidateTotal: 0,
      routeViews: 0,
      mapCalls: 0,
      mapFailures: 0,
      mapMilliseconds: 0,
      maximumGroupSize: 0,
    };
    records.push(record);
  }
  return record;
}
export function summarizeCarpoolMeasurements(
  records: CarpoolMeasurement[] = [],
) {
  const sum = (key: keyof CarpoolMeasurement) =>
    records.reduce((total, row) => total + Number(row[key]), 0);
  const published = sum('published');
  const opened = sum('opened');
  const mapCalls = sum('mapCalls');
  const candidateSamples = sum('candidateSamples');
  return {
    openedUserDays: opened,
    publishedUserDays: published,
    publicationConversion: opened
      ? records.filter((row) => row.opened && row.published).length / opened
      : 0,
    matchedPublisherRatio: published ? records.filter(row=>row.published&&row.matched).length / published : 0,
    averageCandidates: candidateSamples
      ? sum('candidateTotal') / candidateSamples
      : 0,
    routeViews: sum('routeViews'),
    mapCalls,
    mapFailures: sum('mapFailures'),
    mapFailureRatio: mapCalls ? sum('mapFailures') / mapCalls : 0,
    averageMapMilliseconds: mapCalls ? sum('mapMilliseconds') / mapCalls : 0,
    twoPersonUserDays: records.filter((row) => row.maximumGroupSize >= 2)
      .length,
    multiPersonUserDays: records.filter((row) => row.maximumGroupSize >= 3)
      .length,
  };
}
