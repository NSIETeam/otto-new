/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  summarizeDesktopCoverage,
  verifyDesktopCoverageRatchet,
  readCoverageBaseline,
} from '../verify-desktop-coverage-ratchet.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const root = '/fixture/packages/desktop';
const source = 'export function value(flag) { return flag ? 1 : 0; }\n';
const baseLocation = {
  start: { line: 1, column: 0 },
  end: { line: 1, column: 50 },
};
const clone = (value) => structuredClone(value);

// These maps are deliberately synthetic infrastructure fixtures. They are not
// Otto acceptance results and must never become a platform release baseline.
function fixture() {
  const location = clone(baseLocation);
  const file = `${root}/src/value.ts`;
  const coverage = {
    [file]: {
      path: file,
      statementMap: { 0: location },
      s: { 0: 1 },
      fnMap: { 0: { name: 'value', loc: location } },
      f: { 0: 1 },
      branchMap: {
        0: {
          type: 'cond-expr',
          loc: location,
          locations: [location, location],
        },
      },
      b: { 0: [1, 0] },
    },
  };
  const sources = { 'src/value.ts': source };
  const tests = {
    'src/main/value.test.ts': 'it("value", () => expect(true).toBe(true));',
  };
  const environment = {
    platform: 'linux',
    arch: 'x64',
    nodeMajor: 22,
    vitest: '4.1.11',
    coverageV8: '4.1.11',
    mapper: 'ast',
    configSha256: sha('fixed config'),
    lockSha256: sha('fixed lock'),
  };
  const testResults = {
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: `${root}/src/main/value.test.ts`,
        status: 'passed',
        assertionResults: [
          { title: 'value', fullName: 'value', status: 'passed' },
        ],
      },
    ],
  };
  const reportHashes = {
    coverage: sha(JSON.stringify(coverage)),
    tests: sha(JSON.stringify(testResults)),
  };
  const sourceHashes = Object.fromEntries(
    Object.entries({ ...sources, ...tests }).map(([p, code]) => [p, sha(code)]),
  );
  const baseline = {
    schemaVersion: 1,
    status: 'reviewed-measurement-baseline',
    scope: 'desktop-source-v1',
    environment: clone(environment),
    review: {
      reference: 'https://github.com/NSIETeam/otto-new/pull/1',
      sourceCommit: 'a'.repeat(40),
      coverageSha256: reportHashes.coverage,
      testEvidence: { kind: 'vitest-json', sha256: reportHashes.tests },
      measuredConfigSha256: environment.configSha256,
      sourceManifestSha256: sha(
        JSON.stringify(
          Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    },
    tests: Object.keys(tests),
    files: summarizeDesktopCoverage({ coverage, sources, root }),
  };
  const receipt = {
    schemaVersion: 1,
    exitCode: 0,
    environment: clone(environment),
    reportHashes: clone(reportHashes),
    sourceHashesBefore: clone(sourceHashes),
    sourceHashesAfter: clone(sourceHashes),
  };
  return {
    baseline,
    coverage,
    sources,
    tests,
    root,
    environment,
    testResults,
    reportHashes,
    receipt,
  };
}

function rebindReports(input) {
  input.reportHashes = {
    coverage: sha(JSON.stringify(input.coverage)),
    tests: sha(JSON.stringify(input.testResults)),
  };
  input.receipt.reportHashes = clone(input.reportHashes);
}

function rebindSources(input) {
  const hashes = Object.fromEntries(
    Object.entries({ ...input.sources, ...input.tests }).map(([file, code]) => [
      file,
      sha(code),
    ]),
  );
  input.receipt.sourceHashesBefore = clone(hashes);
  input.receipt.sourceHashesAfter = clone(hashes);
  rebindReports(input);
}

describe('desktop per-platform AST coverage ratchet (infrastructure only)', () => {
  it.each(['DRAFT', 'DRAFT-not-reviewed', undefined])(
    'rejects a non-reviewed baseline status: %s',
    (status) => {
      const input = fixture();
      if (status === undefined) delete input.baseline.status;
      else input.baseline.status = status;
      expect(() => verifyDesktopCoverageRatchet(input)).toThrow(
        /reviewed|status/i,
      );
    },
  );

  it('rejects empty maps after a comment changes the source byte hash', () => {
    const input = fixture();
    input.sources['src/value.ts'] += '// same executable program\n';
    const item = Object.values(input.coverage)[0];
    for (const key of ['statementMap', 's', 'fnMap', 'f', 'branchMap', 'b'])
      item[key] = {};
    rebindSources(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(
      /map.*changed|empty.*observation|review/i,
    );
  });

  it.each([
    'export function neverTested() { throw new Error("not tested"); }',
    'export type OnlyType = { enabled: boolean };',
    '// comments alone are not observed executable coverage\n',
  ])('requires explicit review for new zero-observation source: %s', (code) => {
    const input = fixture();
    input.sources['src/new.ts'] = code;
    const file = `${root}/src/new.ts`;
    input.coverage[file] = {
      path: file,
      statementMap: {},
      s: {},
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };
    rebindSources(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(
      /zero|empty|observation|review/i,
    );
  });

  it('requires reviewed baseline renewal for structural source changes and partial map deletion', () => {
    const input = fixture();
    input.sources['src/value.ts'] = source.replace('1 : 0', '2 : 0');
    const item = Object.values(input.coverage)[0];
    item.branchMap = {};
    item.b = {};
    rebindSources(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(
      /structure|review/i,
    );
  });

  it('distinguishes identical branch fragments at different occurrences in the same scope', () => {
    const input = fixture();
    const code = 'if (flag) yes(); else no();';
    input.sources['src/value.ts'] = `${code}\n${code}\n`;
    const loc = (line) => ({
      start: { line, column: 0 },
      end: { line, column: code.length },
    });
    const item = Object.values(input.coverage)[0];
    item.statementMap = { 0: loc(1), 1: loc(2) };
    item.s = { 0: 1, 1: 1 };
    item.fnMap = {};
    item.f = {};
    item.branchMap = {
      0: { type: 'if', loc: loc(1), locations: [loc(1), loc(1)] },
      1: { type: 'if', loc: loc(2), locations: [loc(2), loc(2)] },
    };
    item.b = { 0: [1, 0], 1: [1, 1] };
    input.baseline.files = summarizeDesktopCoverage(input);
    item.b = { 0: [1, 1], 1: [1, 0] };
    rebindSources(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/new uncovered/);
  });

  it.each(['space', 'CRLF'])(
    'preserves uncovered-site identity across harmless %s formatting',
    (kind) => {
      const input = fixture();
      if (kind === 'space') {
        input.sources['src/value.ts'] = source.replace(
          'return flag',
          'return  flag',
        );
        // All fixture map locations intentionally refer to this one shared span.
        Object.values(input.coverage)[0].statementMap[0].end.column = 51;
      } else input.sources['src/value.ts'] = source.replaceAll('\n', '\r\n');
      rebindSources(input);
      expect(verifyDesktopCoverageRatchet(input).uncovered.branches).toBe(1);
    },
  );

  it('rejects coverage ignore hints even when executable AST tokens are unchanged', () => {
    const input = fixture();
    input.sources['src/value.ts'] += '/* v8 ignore next */\n';
    rebindSources(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(
      /instrumentation|review/i,
    );
  });

  it('does not miss an ignore hint after an unrelated leading comment', () => {
    const input = fixture();
    const original = summarizeDesktopCoverage(input)['src/value.ts'];
    input.sources['src/value.ts'] +=
      '// normal comment\n/* v8 ignore next */\n';
    const changed = summarizeDesktopCoverage(input)['src/value.ts'];
    expect(changed.structureSha256).toBe(original.structureSha256);
    expect(changed.instrumentationSha256).not.toBe(
      original.instrumentationSha256,
    );
  });

  it('does not confuse strings or template text with instrumentation comments', () => {
    const input = fixture();
    input.sources['src/value.ts'] =
      'export const example = `text ${1} /* v8 ignore next */`;';
    const item = Object.values(input.coverage)[0];
    for (const key of ['statementMap', 's', 'fnMap', 'f', 'branchMap', 'b'])
      item[key] = {};
    expect(summarizeDesktopCoverage(input)['src/value.ts'].hasIgnoreHints).toBe(
      false,
    );
  });

  it('rejects real AST mapper ignore-next removing a previously observed function', async () => {
    const { convert } = await import('ast-v8-to-istanbul');
    const { parseAstAsync } = await import('vite');
    const input = fixture();
    const file = `${root}/src/value.ts`;
    const raw = async (code) => {
      const result = await convert({
        code,
        ast: await parseAstAsync(code),
        wrapperLength: 0,
        coverage: {
          url: new URL('./readonly-ignore-fixture.js', import.meta.url).href,
          functions: [
            {
              functionName: '',
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: code.length, count: 0 }],
            },
          ],
        },
      });
      // The real report format serializes the AST Infinity sentinel to null.
      return {
        ...JSON.parse(JSON.stringify(Object.values(result)[0])),
        path: file,
      };
    };
    input.coverage[file] = await raw(source);
    input.baseline.files = summarizeDesktopCoverage(input);
    input.sources['src/value.ts'] = `/* v8 ignore next */\n${source}`;
    input.coverage[file] = await raw(input.sources['src/value.ts']);
    expect(Object.keys(input.coverage[file].fnMap)).toHaveLength(0);
    rebindSources(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(
      /instrumentation|map.*changed|review/i,
    );
  });

  it('retains a separately reviewed zero-map type-only baseline without calling it full coverage', () => {
    const input = fixture();
    input.sources['src/value.ts'] =
      'export interface Shape { enabled: boolean }';
    const item = Object.values(input.coverage)[0];
    for (const key of ['statementMap', 's', 'fnMap', 'f', 'branchMap', 'b'])
      item[key] = {};
    input.baseline.files = summarizeDesktopCoverage(input);
    rebindSources(input);
    expect(input.baseline.files['src/value.ts'].metrics.functions.total).toBe(
      0,
    );
    expect(verifyDesktopCoverageRatchet(input).files).toBe(1);
  });

  it.each(['vitest-json', 'github-job-log'])(
    'keeps accurately labelled baseline test evidence: %s',
    (kind) => {
      const input = fixture();
      input.baseline.review.testEvidence.kind = kind;
      input.baseline.review.measuredConfigSha256 = sha(
        'original unchanged instrumentation config with old thresholds',
      );
      expect(verifyDesktopCoverageRatchet(input).tests).toBe(1);
    },
  );

  it.each(['kind', 'hash', 'measured config', 'legacy field only'])(
    'rejects incomplete baseline provenance: %s',
    (kind) => {
      const input = fixture();
      if (kind === 'kind')
        input.baseline.review.testEvidence.kind = 'success-claim';
      if (kind === 'hash') input.baseline.review.testEvidence.sha256 = '';
      if (kind === 'measured config')
        delete input.baseline.review.measuredConfigSha256;
      if (kind === 'legacy field only') {
        input.baseline.review.testResultsSha256 =
          input.baseline.review.testEvidence.sha256;
        delete input.baseline.review.testEvidence;
      }
      expect(() => verifyDesktopCoverageRatchet(input)).toThrow(
        /review|provenance/i,
      );
    },
  );

  it('does not treat automatic-semicolon-insertion behavior changes as formatting', () => {
    const input = fixture();
    input.sources['src/value.ts'] = source.replace(
      'return flag',
      'return\nflag',
    );
    // Current synthetic map remains valid, but its source semantics are different.
    const loc = {
      start: { line: 1, column: 0 },
      end: {
        line: 2,
        column: input.sources['src/value.ts'].split('\n')[1].length,
      },
    };
    const item = Object.values(input.coverage)[0];
    item.statementMap[0] = loc;
    item.fnMap[0].loc = loc;
    item.branchMap[0].loc = loc;
    item.branchMap[0].locations = [loc, loc];
    rebindSources(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(
      /structure|review/i,
    );
  });

  it('accepts complete identical evidence without mutating the reviewed baseline', () => {
    const input = fixture();
    const before = JSON.stringify(input.baseline);
    expect(verifyDesktopCoverageRatchet(input).files).toBe(1);
    expect(JSON.stringify(input.baseline)).toBe(before);
  });

  it('accepts newly covered branches, not just a better global percentage', () => {
    const input = fixture();
    Object.values(input.coverage)[0].b[0][1] = 1;
    rebindReports(input);
    expect(verifyDesktopCoverageRatchet(input).uncovered.branches).toBe(0);
  });

  it('handles the real AST mapper end-of-line Infinity serialized as JSON null', () => {
    const input = fixture();
    Object.values(input.coverage)[0].statementMap[0].end.column = null;
    expect(
      summarizeDesktopCoverage(input)['src/value.ts'].metrics.statements,
    ).toEqual({ total: 1, uncovered: 0 });
  });

  it('counts an implicit if-false arm without a source span as uncovered', () => {
    const input = fixture();
    const branch = Object.values(input.coverage)[0].branchMap[0];
    branch.type = 'if';
    branch.locations[1] = { start: {}, end: {} };
    expect(
      summarizeDesktopCoverage(input)['src/value.ts'].metrics.branches,
    ).toEqual({ total: 2, uncovered: 1 });
  });

  it.each(['coverage', 'source', 'baseline source'])(
    'rejects a missing %s file',
    (kind) => {
      const input = fixture();
      if (kind === 'coverage') input.coverage = {};
      if (kind === 'source') input.sources = {};
      if (kind === 'baseline source')
        delete input.baseline.files['src/value.ts'];
      rebindReports(input);
      expect(() => verifyDesktopCoverageRatchet(input)).toThrow();
    },
  );

  it('rejects newly added source with unobserved branches', () => {
    const input = fixture();
    input.sources['src/new.ts'] = source;
    const file = `${root}/src/new.ts`;
    input.coverage[file] = {
      ...clone(Object.values(input.coverage)[0]),
      path: file,
    };
    input.receipt.sourceHashesBefore['src/new.ts'] = sha(source);
    input.receipt.sourceHashesAfter['src/new.ts'] = sha(source);
    rebindReports(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/new.*review/i);
  });

  it('requires explicit review even for apparently fully observed new source', () => {
    const input = fixture();
    input.sources['src/new.ts'] = source;
    const file = `${root}/src/new.ts`;
    input.coverage[file] = {
      ...clone(Object.values(input.coverage)[0]),
      path: file,
      b: { 0: [1, 1] },
    };
    input.receipt.sourceHashesBefore['src/new.ts'] = sha(source);
    input.receipt.sourceHashesAfter['src/new.ts'] = sha(source);
    rebindReports(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/new.*review/i);
  });

  it('rejects new runtime source hidden behind one statement but no function/branch map', () => {
    const input = fixture();
    input.sources['src/new.ts'] = source;
    const file = `${root}/src/new.ts`;
    input.coverage[file] = {
      path: file,
      statementMap: { 0: clone(baseLocation) },
      s: { 0: 1 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };
    rebindSources(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/new.*review/i);
  });

  it.each([
    'platform',
    'arch',
    'nodeMajor',
    'vitest',
    'coverageV8',
    'mapper',
    'configSha256',
    'lockSha256',
  ])('rejects a changed %s measurement environment', (key) => {
    const input = fixture();
    input.environment[key] = key === 'nodeMajor' ? 24 : 'changed';
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/environment/);
  });

  it('does not trust a summary percentage or top-level success claim', () => {
    const input = fixture();
    input.coverage.total = { branches: { pct: 100 }, success: true };
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow();
    delete input.coverage.total;
    input.testResults.testResults[0].assertionResults[0].status = 'failed';
    rebindReports(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/test/);
  });

  it.each(['exit', 'coverage hash', 'test hash', 'before', 'after'])(
    'rejects invalid or stale %s evidence',
    (kind) => {
      const input = fixture();
      if (kind === 'exit') input.receipt.exitCode = 1;
      if (kind === 'coverage hash')
        input.receipt.reportHashes.coverage = 'b'.repeat(64);
      if (kind === 'test hash')
        input.receipt.reportHashes.tests = 'b'.repeat(64);
      if (kind === 'before')
        input.receipt.sourceHashesBefore['src/value.ts'] = 'b'.repeat(64);
      if (kind === 'after')
        input.receipt.sourceHashesAfter['src/value.ts'] = 'b'.repeat(64);
      expect(() => verifyDesktopCoverageRatchet(input)).toThrow();
    },
  );

  it.each(['missing', 'skipped', 'zero', 'counter'])(
    'rejects %s test execution despite success=true',
    (kind) => {
      const input = fixture();
      if (kind === 'missing') input.testResults.testResults = [];
      if (kind === 'skipped')
        input.testResults.testResults[0].assertionResults[0].status = 'pending';
      if (kind === 'zero')
        input.testResults.testResults[0].assertionResults = [];
      if (kind === 'counter') input.testResults.numTotalTests = 2;
      rebindReports(input);
      expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/test/);
    },
  );

  it('rejects deleting a previous test even if the remaining tests pass', () => {
    const input = fixture();
    input.baseline.tests.push('src/main/previous.test.ts');
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/test/);
  });

  it.each([
    'negative',
    'nan',
    'missing hit',
    'missing arm',
    'outside',
    'duplicate',
  ])('rejects malformed raw coverage: %s', (kind) => {
    const input = fixture();
    const item = Object.values(input.coverage)[0];
    if (kind === 'negative') item.f[0] = -1;
    if (kind === 'nan') item.b[0][0] = NaN;
    if (kind === 'missing hit') delete item.s[0];
    if (kind === 'missing arm') item.b[0].pop();
    if (kind === 'outside') input.coverage['/elsewhere/src/value.ts'] = item;
    if (kind === 'duplicate') input.coverage[`${root}/src/./value.ts`] = item;
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow();
  });

  it('rejects silently shrinking maps for unchanged source', () => {
    const input = fixture();
    const item = Object.values(input.coverage)[0];
    item.branchMap = {};
    item.b = {};
    rebindReports(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/map.*changed/);
  });

  it('rejects trading one uncovered branch for a newly uncovered different arm', () => {
    const input = fixture();
    Object.values(input.coverage)[0].b[0] = [0, 1];
    rebindReports(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/new uncovered/);
  });

  it('preserves a negative branch hit as uncovered and reports the anomaly', () => {
    const input = fixture();
    Object.values(input.coverage)[0].b[0][1] = -1;
    rebindReports(input);
    const before = JSON.stringify(input.coverage);
    const result = verifyDesktopCoverageRatchet(input);
    expect(result.uncovered.branches).toBe(1);
    expect(result.anomalies.negativeBranchHits).toBe(1);
    expect(JSON.stringify(input.coverage)).toBe(before);
  });

  it.each([NaN, Infinity, -Infinity, null, 0.5])(
    'rejects an invalid branch observation %s',
    (hit) => {
      const input = fixture();
      Object.values(input.coverage)[0].b[0][1] = hit;
      rebindReports(input);
      expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/branch hit/);
    },
  );

  it('does not let negative hits pass a newly uncovered arm', () => {
    const input = fixture();
    Object.values(input.coverage)[0].b[0] = [-1, 1];
    rebindReports(input);
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/new uncovered/);
  });

  it('reproduces negative implicit-else hits through the installed AST mapper', async () => {
    const { convert } = await import('ast-v8-to-istanbul');
    const { parseAstAsync } = await import('vite');
    const code = 'if (ready) done();';
    // Synthetic V8 ranges reproduce the asynchronous parent/child count
    // mismatch seen in the unmodified EnterpriseAdministrationPanel report.
    const raw = await convert({
      code,
      ast: await parseAstAsync(code),
      wrapperLength: 0,
      coverage: {
        url: new URL('./implicit-mapper-fixture.js', import.meta.url).href,
        functions: [
          {
            functionName: '',
            isBlockCoverage: true,
            ranges: [
              { startOffset: 0, endOffset: code.length, count: 0 },
              {
                startOffset: code.indexOf('done'),
                endOffset: code.length,
                count: 1,
              },
            ],
          },
        ],
      },
    });
    const actual = Object.values(raw)[0];
    expect(Object.values(actual.b)).toContainEqual([1, -1]);
    expect(Object.values(actual.branchMap)[0].type).toBe('if');
  });

  it('refuses a runtime baseline-update argument instead of writing any baseline', () => {
    const script = fileURLToPath(
      new URL('../verify-desktop-coverage-ratchet.mjs', import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [script, '--update-baseline', 'forbidden.json'],
      { encoding: 'utf8', shell: false, windowsHide: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('only explicit read-only input arguments');
  });

  it('requires a review identity, not runtime generated success=true metadata', () => {
    const input = fixture();
    delete input.baseline.review;
    expect(() => verifyDesktopCoverageRatchet(input)).toThrow(/review/);
  });
});

describe('reviewed compressed baseline reader', () => {
  function withDirectory(callback) {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'otto-baseline-fixture-'),
    );
    try {
      callback(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('reads an exact gzip JSON baseline without writing or accepting it', () =>
    withDirectory((directory) => {
      const file = path.join(directory, 'baseline.json.gz');
      const baseline = fixture().baseline;
      writeFileSync(file, gzipSync(JSON.stringify(baseline)));
      expect(readCoverageBaseline(file)).toEqual(baseline);
    }));

  it.each([
    'directory',
    'missing',
    'not gzip',
    'oversize compressed',
    'oversize inflated',
  ])('rejects %s baseline input', (kind) =>
    withDirectory((directory) => {
      const file = path.join(directory, 'baseline.json.gz');
      if (kind === 'not gzip') writeFileSync(file, '{}');
      if (kind === 'oversize compressed')
        writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1));
      if (kind === 'oversize inflated')
        writeFileSync(file, gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1)));
      expect(() =>
        readCoverageBaseline(kind === 'directory' ? directory : file),
      ).toThrow();
    }),
  );
});
