import { expect, it } from 'vitest';
import {
  carpoolMeasurement,
  summarizeCarpoolMeasurements,
  type CarpoolMeasurement,
} from './parkCarpoolMetrics.js';
it('deduplicates user-day conversions while averaging real observations and retaining no positions', () => {
  const state: { measurements?: CarpoolMeasurement[] } = {};
  const first = carpoolMeasurement(state, 'a', '2026-09-08T00:00:00Z');
  first.opened = true;
  first.published = true;
  first.matched = true;
  first.candidateSamples = 2;
  first.candidateTotal = 6;
  first.mapCalls = 2;
  first.mapFailures = 1;
  first.mapMilliseconds = 100;
  expect(carpoolMeasurement(state, 'a', '2026-09-08T01:00:00Z')).toBe(first);
  carpoolMeasurement(state, 'b', '2026-09-08T00:00:00Z').opened = true;
  carpoolMeasurement(state,'migrated','2026-09-08T00:00:00Z').matched=true;
  expect(summarizeCarpoolMeasurements(state.measurements)).toMatchObject({
    publicationConversion: 0.5,
    matchedPublisherRatio: 1,
    averageCandidates: 3,
    mapFailureRatio: 0.5,
    averageMapMilliseconds: 50,
  });
  expect(JSON.stringify(state)).not.toMatch(/longitude|latitude|routePolyline/);
});
