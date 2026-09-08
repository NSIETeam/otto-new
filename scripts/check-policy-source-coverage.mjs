/** Read-only public-source probe. No enterprise DB, profile or model calls. */
import { writeFile } from 'node:fs/promises';
import {
  loadPolicySources,
  collectPolicySource,
} from '../packages/server/dist/src/modules/policy_intelligence/policySources.js';
const output = process.argv[2];
if (!output || !/\.json$/iu.test(output))
  throw new Error(
    'Usage: node scripts/check-policy-source-coverage.mjs <report.json>',
  );
const sources = loadPolicySources();
const results = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (;;) {
      const source = sources[cursor++];
      if (!source) return;
      const started = Date.now();
      const failures = [];
      try {
        const docs = await collectPolicySource(
          source,
          fetch,
          AbortSignal.timeout(20_000),
          new Date(),
          (url) => failures.push(url),
        );
        results.push({
          sourceId: source.id,
          url: source.listUrl,
          status: docs.length
            ? failures.length || docs.some(d => d.sourceStatus !== 'verified')
              ? 'partial'
              : 'available'
            : 'unavailable',
          documents: docs.map((d) => ({
            title: d.title,
            url: d.url,
            attachments: d.attachments.map((a) => ({
              url: a.url,
              status: a.status,
              reason: a.reason,
            })),
          })),
          detailFailures: failures.length,
          elapsedMs: Date.now() - started,
        });
      } catch (error) {
        results.push({
          sourceId: source.id,
          url: source.listUrl,
          status: 'unavailable',
          error: error instanceof Error ? error.message : 'probe failed',
          elapsedMs: Date.now() - started,
        });
      }
      console.log(
        `${source.id}: ${results.find((r) => r.sourceId === source.id).status}`,
      );
    }
  }),
);
await writeFile(
  output,
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      scope:
        'Public sources only; successful sampling is not exhaustive coverage',
      results: results.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    total: results.length,
    available: results.filter((r) => r.status === 'available').length,
    partial: results.filter((r) => r.status === 'partial').length,
    unavailable: results.filter((r) => r.status === 'unavailable').length,
    report: output,
  }),
);
