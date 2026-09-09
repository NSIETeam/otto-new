/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import type { ParkCarpoolMatch } from './parkCarpoolDomain.js';
import type { CarpoolGroupMatch } from './parkCarpoolGroupMatching.js';
export interface CarpoolResultsQuery {
  cursor?: string;
  filter?: string;
}
type Result = ParkCarpoolMatch | CarpoolGroupMatch;
type Rank = [number, number, number, number, string];
const rank = (match: Result): Rank => [
  Number(match.freshness === 'needs_confirmation'),
  -match.overlapPercent,
  match.timeDifferenceMinutes,
  -match.commonDistanceMeters,
  `${'groupId' in match ? match.groupId : ''}:${match.intentId}`,
];
const compare = (a: Rank, b: Rank) =>
  a[0] - b[0] ||
  a[1] - b[1] ||
  a[2] - b[2] ||
  a[3] - b[3] ||
  a[4].localeCompare(b[4]);
/** Memory is bounded by a page, regardless of how many database pages are scanned. */
export function createCarpoolResultPage(
  query: CarpoolResultsQuery = {},
  targetIntentId?: string,
) {
  const filter = query.filter ?? 'all';
  if (
    ![
      'all',
      'shared_taxi',
      'current_rides_candidate_vehicle',
      'candidate_rides_current_vehicle',
    ].includes(filter)
  )
    throw new Error('同行筛选无效');
  let cursor: { hash: string; last: Rank; filter: string } | undefined;
  if (query.cursor) {
    try {
      if (query.cursor.length > 2048) throw new Error();
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
      if (
        !cursor ||
        typeof cursor.hash !== 'string' ||
        cursor.filter !== filter ||
        !Array.isArray(cursor.last) ||
        cursor.last.length !== 5 ||
        cursor.last
          .slice(0, 4)
          .some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
        typeof cursor.last[4] !== 'string'
      )
        throw new Error();
    } catch {
      throw new Error('同行分页参数无效，请刷新结果');
    }
  }
  const digest = createHash('sha256');
  const results: Result[] = [];
  let total = 0;
  let remaining = 0;
  return {
    add(match: Result) {
      if (targetIntentId && match.intentId !== targetIntentId) return;
      if (
        filter !== 'all' &&
        !match.compatibleModes.includes(
          filter as ParkCarpoolMatch['compatibleModes'][number],
        )
      )
        return;
      total++;
      digest.update(
        JSON.stringify([
          rank(match),
          match.candidateVersion,
          'groupVersion' in match ? match.groupVersion : 0,
        ]),
      );
      if (cursor && compare(rank(match), cursor.last) <= 0) return;
      remaining++;
      results.push(match);
      results.sort((a, b) => compare(rank(a), rank(b)));
      if (results.length > 50) results.pop();
    },
    finish() {
      const hash = digest.digest('hex');
      if (cursor && cursor.hash !== hash)
        throw new Error('同行结果已更新，请刷新后重新浏览');
      return {
        results,
        total,
        nextCursor:
          remaining > results.length
            ? Buffer.from(
                JSON.stringify({ hash, filter, last: rank(results.at(-1)!) }),
              ).toString('base64url')
            : undefined,
      };
    },
  };
}
