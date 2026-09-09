#!/usr/bin/env node
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

const METRICS = ['lines', 'statements', 'functions', 'branches'];
const ENVIRONMENT = [
  'platform',
  'arch',
  'nodeMajor',
  'vitest',
  'coverageV8',
  'mapper',
  'configSha256',
  'lockSha256',
];
const HASH = /^[a-f0-9]{64}$/;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => {
  throw new Error(`[desktop-coverage-ratchet] ${message}`);
};
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const canonical = (value) =>
  JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

function relative(file, root) {
  if (typeof file !== 'string' || typeof root !== 'string')
    fail('invalid report path');
  const normalized = file.replaceAll('\\', '/');
  const prefix = `${root.replaceAll('\\', '/').replace(/\/$/, '')}/`;
  if (!normalized.startsWith(prefix)) fail('report path outside source root');
  const result = normalized.slice(prefix.length);
  validatePath(result);
  return result;
}

function validatePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    /[\\:\0]/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail('noncanonical relative path');
}

function isSource(file) {
  return (
    file.startsWith('src/') &&
    /\.(ts|tsx)$/.test(file) &&
    !/\.test\.(ts|tsx)$|\.d\.ts$/.test(file) &&
    file !== 'src/renderer/test-setup.ts'
  );
}

function isTest(file) {
  return (
    /^src\/renderer\/.*\.test\.(ts|tsx)$/.test(file) ||
    /^src\/(main|preload)\/.*\.test\.ts$/.test(file) ||
    /^scripts\/.*\.test\.mjs$/.test(file)
  );
}

function sameKeys(left, right, label) {
  if (
    !object(left) ||
    !object(right) ||
    canonical(Object.fromEntries(Object.keys(left).map((k) => [k, true]))) !==
      canonical(Object.fromEntries(Object.keys(right).map((k) => [k, true])))
  )
    fail(`${label} keys differ`);
}

function snippet(location, lines) {
  const start = location?.start;
  const end = location?.end;
  // ast-v8-to-istanbul uses Infinity for an end-of-line source-map span;
  // JSON serializes that sentinel as null. Only this end column is nullable.
  const endColumn =
    end?.column === null ? lines[end.line - 1]?.length : end?.column;
  if (
    !start ||
    !end ||
    !integer(start.line) ||
    !integer(end.line) ||
    start.line < 1 ||
    end.line < start.line ||
    end.line > lines.length ||
    !integer(start.column) ||
    !integer(endColumn) ||
    start.column > lines[start.line - 1].length ||
    endColumn > lines[end.line - 1].length ||
    (start.line === end.line && endColumn < start.column)
  )
    fail('invalid raw coverage location');
  return lines
    .slice(start.line - 1, end.line)
    .map((line, i, selected) =>
      line.slice(
        i === 0 ? start.column : 0,
        i === selected.length - 1 ? endColumn : undefined,
      ),
    )
    .join('\n');
}

function metric(entries) {
  return {
    total: entries.length,
    uncovered: entries.filter((entry) => entry.hits <= 0).length,
  };
}

// Raw bytes remain bound separately. AST tokens normalize harmless whitespace /
// CRLF, while node hierarchy preserves semantics such as `return\nexpression`.
// This is deliberately NOT semantic equivalence for refactors: changed syntax
// requires independent baseline review, never an unobserved-map exemption.
function sourceIdentity(file, source) {
  const syntax = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (syntax.parseDiagnostics.length)
    fail(`source syntax requires review: ${file}`);
  const tokens = [],
    scopes = [],
    comments = new Map();
  let scopeNumber = 0;
  const rememberComment = (start, end) => {
    comments.set(start, source.slice(start, end));
  };
  function visit(node, owner = 'file') {
    ts.forEachLeadingCommentRange(source, node.pos, rememberComment);
    ts.forEachTrailingCommentRange(source, node.end, rememberComment);
    const isScope = ts.isFunctionLike(node) || ts.isClassLike(node);
    const scope = isScope
      ? `${owner}/${ts.SyntaxKind[node.kind]}:${node.name?.getText(syntax) ?? ''}:${scopeNumber++}`
      : owner;
    if (isScope)
      scopes.push({ start: node.getStart(syntax), end: node.end, scope });
    const children = node
      .getChildren(syntax)
      .filter(
        (child) =>
          child.kind < ts.SyntaxKind.FirstJSDocNode ||
          child.kind > ts.SyntaxKind.LastJSDocNode,
      );
    if (children.length)
      return [node.kind, children.map((child) => visit(child, scope))];
    const text = node
      .getText(syntax)
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n');
    if (
      node.kind <= ts.SyntaxKind.LastToken &&
      node.kind !== ts.SyntaxKind.EndOfFileToken
    )
      tokens.push({
        start: node.getStart(syntax),
        end: node.end,
        value: [node.kind, text],
      });
    return [node.kind, text];
  }
  const structureSha256 = sha(JSON.stringify(visit(syntax)));
  const hints = [...comments]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .filter((text) => /(?:istanbul|[cv]8|node:coverage)\s+ignore\b/.test(text))
    .map((text) => text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
  const instrumentationSha256 = sha(JSON.stringify(hints));
  const lineStarts = syntax.getLineStarts();
  function lowerBound(value, key, strict) {
    let low = 0,
      high = tokens.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (strict ? tokens[middle][key] <= value : tokens[middle][key] < value)
        low = middle + 1;
      else high = middle;
    }
    return low;
  }
  function site(kind, location, lines) {
    snippet(location, lines); // Validate current report positions against actual current bytes.
    const start = lineStarts[location.start.line - 1] + location.start.column;
    const end =
      lineStarts[location.end.line - 1] +
      (location.end.column ?? lines[location.end.line - 1].length);
    const first = lowerBound(start, 'end', true),
      last = lowerBound(end, 'start', false);
    const anchor = tokens[first]?.start ?? start;
    let owner = 'file',
      width = Infinity;
    for (const scope of scopes)
      if (
        scope.start <= anchor &&
        anchor < scope.end &&
        scope.end - scope.start < width
      ) {
        owner = scope.scope;
        width = scope.end - scope.start;
      }
    // Token indices distinguish two identical fragments in one scope, not just
    // identical text or a per-hash multiset. They are stable only under trivia edits.
    return sha(
      JSON.stringify([
        kind,
        owner,
        first,
        last,
        tokens.slice(first, last).map((token) => token.value),
      ]),
    );
  }
  return {
    structureSha256,
    instrumentationSha256,
    hasIgnoreHints: hints.length > 0,
    site,
  };
}

/** Derive counts from raw maps, never summary percentages or success fields. */
export function summarizeDesktopCoverage({ coverage, sources, root }) {
  if (
    !object(coverage) ||
    !object(sources) ||
    Object.keys(sources).length === 0
  )
    fail('missing source or coverage observation');
  for (const [file, source] of Object.entries(sources)) {
    validatePath(file);
    if (!isSource(file) || typeof source !== 'string')
      fail('invalid source inventory');
  }
  const result = {};
  for (const [reportedPath, item] of Object.entries(coverage)) {
    const file = relative(reportedPath, root);
    if (
      !Object.hasOwn(sources, file) ||
      Object.hasOwn(result, file) ||
      relative(item?.path, root) !== file
    )
      fail('duplicate or unexpected coverage file');
    const source = sources[file];
    const lines = source.split('\n');
    const identity = sourceIdentity(file, source);
    const entries = { statements: [], functions: [], branches: [], lines: [] };
    for (const [hitsKey, mapKey] of [
      ['s', 'statementMap'],
      ['f', 'fnMap'],
      ['b', 'branchMap'],
    ])
      sameKeys(item[hitsKey], item[mapKey], `raw ${hitsKey} map`);
    const observedLines = new Map();
    for (const [id, location] of Object.entries(item.statementMap)) {
      const hits = item.s[id];
      if (!integer(hits)) fail('invalid statement hit count');
      entries.statements.push({
        hits,
        signature: identity.site('statement', location, lines),
      });
      observedLines.set(
        location.start.line,
        Math.max(observedLines.get(location.start.line) ?? 0, hits),
      );
    }
    for (const [line, hits] of observedLines)
      entries.lines.push({
        hits,
        signature: identity.site(
          'line',
          {
            start: { line, column: 0 },
            end: { line, column: lines[line - 1].length },
          },
          lines,
        ),
      });
    for (const [id, entry] of Object.entries(item.fnMap)) {
      const hits = item.f[id];
      if (!integer(hits) || typeof entry.name !== 'string')
        fail('invalid function hit count or map');
      entries.functions.push({
        hits,
        signature: identity.site(`function:${entry.name}`, entry.loc, lines),
      });
    }
    for (const [id, entry] of Object.entries(item.branchMap)) {
      const hits = item.b[id];
      if (
        !Array.isArray(hits) ||
        !Array.isArray(entry.locations) ||
        hits.length !== entry.locations.length ||
        hits.length === 0 ||
        typeof entry.type !== 'string'
      )
        fail('invalid branch arm observations');
      const enclosing = identity.site(`branch:${entry.type}`, entry.loc, lines);
      entry.locations.forEach((location, index) => {
        // The AST mapper derives a missing else as parentHits - trueArmHits;
        // asynchronous V8 ranges can yield -1. Istanbul counts only >0 as
        // covered. Preserve negative raw hits and expose the anomaly below.
        if (!Number.isSafeInteger(hits[index]))
          fail('invalid branch hit count');
        // Istanbul represents the missing `else` arm with empty locations. It
        // still counts as a branch; bind it to the enclosing if, never drop it.
        const implicitElse =
          entry.type === 'if' &&
          index === 1 &&
          hits.length === 2 &&
          object(location?.start) &&
          object(location?.end) &&
          Object.keys(location.start).length === 0 &&
          Object.keys(location.end).length === 0;
        const arm = implicitElse
          ? '<implicit-else>'
          : identity.site('arm', location, lines);
        entries.branches.push({
          hits: hits[index],
          signature: sha(`branch:${entry.type}:${enclosing}:${index}:${arm}`),
        });
      });
    }
    result[file] = {
      sourceSha256: sha(source),
      signatureVersion: 'typescript-ast-sites-v2',
      structureSha256: identity.structureSha256,
      instrumentationSha256: identity.instrumentationSha256,
      hasIgnoreHints: identity.hasIgnoreHints,
      mapSha256: sha(
        JSON.stringify(
          METRICS.map((key) => [
            key,
            entries[key].map((entry) => entry.signature).sort(),
          ]),
        ),
      ),
      metrics: Object.fromEntries(
        METRICS.map((key) => [key, metric(entries[key])]),
      ),
      uncoveredSites: Object.fromEntries(
        METRICS.map((key) => [
          key,
          entries[key]
            .filter((entry) => entry.hits <= 0)
            .map((entry) => entry.signature)
            .sort(),
        ]),
      ),
      anomalies: {
        negativeBranchHits: entries.branches.filter((entry) => entry.hits < 0)
          .length,
      },
    };
  }
  sameKeys(result, sources, 'source and coverage file');
  return result;
}

function validateEnvironment(actual, expected) {
  if (
    !object(actual) ||
    !object(expected) ||
    ENVIRONMENT.some((key) => actual[key] !== expected[key]) ||
    !['win32', 'darwin', 'linux'].includes(actual.platform) ||
    !['x64', 'arm64'].includes(actual.arch) ||
    !integer(actual.nodeMajor) ||
    actual.nodeMajor < 22 ||
    !/^4\./.test(actual.vitest) ||
    actual.vitest !== actual.coverageV8 ||
    actual.mapper !== 'ast' ||
    !HASH.test(actual.configSha256) ||
    !HASH.test(actual.lockSha256)
  )
    fail('measurement environment differs or is unsupported');
}

function validateTests(report, tests, baselineTests, root) {
  if (
    !object(tests) ||
    Object.keys(tests).length === 0 ||
    !Array.isArray(baselineTests) ||
    baselineTests.length === 0 ||
    baselineTests.some((file) => !Object.hasOwn(tests, file)) ||
    new Set(baselineTests).size !== baselineTests.length
  )
    fail('missing previous or current test inventory');
  for (const [file, code] of Object.entries(tests)) {
    validatePath(file);
    if (!isTest(file) || typeof code !== 'string')
      fail('invalid test inventory');
  }
  if (!Array.isArray(report?.testResults))
    fail('missing detailed test results');
  const seen = {};
  let count = 0;
  for (const suite of report.testResults) {
    const file = relative(suite.name, root);
    if (
      !Object.hasOwn(tests, file) ||
      Object.hasOwn(seen, file) ||
      suite.status !== 'passed' ||
      !Array.isArray(suite.assertionResults) ||
      suite.assertionResults.length === 0 ||
      suite.assertionResults.some((test) => test.status !== 'passed')
    )
      fail('test file missing, failed, skipped, empty or repeated');
    seen[file] = true;
    count += suite.assertionResults.length;
  }
  sameKeys(seen, tests, 'executed test file');
  if (
    report.numTotalTests !== count ||
    report.numPassedTests !== count ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  )
    fail('test counters do not match executed assertions');
  return count;
}

function assertSites(current, previous, file, key) {
  if (!Array.isArray(previous) || previous.some((value) => !HASH.test(value)))
    fail('invalid reviewed uncovered-site evidence');
  const available = new Map();
  for (const value of previous)
    available.set(value, (available.get(value) ?? 0) + 1);
  for (const value of current) {
    const remaining = available.get(value) ?? 0;
    if (remaining === 0) fail(`new uncovered ${key} site in ${file}`);
    available.set(value, remaining - 1);
  }
}

/** Read-only verifier. It has no baseline creation/update mode. */
export function verifyDesktopCoverageRatchet({
  baseline,
  coverage,
  sources,
  tests,
  root,
  environment,
  testResults,
  reportHashes,
  receipt,
}) {
  if (
    baseline?.schemaVersion !== 1 ||
    baseline.status !== 'reviewed-measurement-baseline' ||
    baseline.scope !== 'desktop-source-v1' ||
    !object(baseline.files)
  )
    fail('invalid reviewed baseline schema');
  if (
    !/^https:\/\/github\.com\/NSIETeam\/otto-new\/pull\/\d+$/.test(
      baseline.review?.reference ?? '',
    ) ||
    !/^[a-f0-9]{40}$/.test(baseline.review?.sourceCommit ?? '') ||
    !['coverageSha256', 'sourceManifestSha256', 'measuredConfigSha256'].every(
      (key) => HASH.test(baseline.review?.[key] ?? ''),
    ) ||
    !['vitest-json', 'github-job-log'].includes(
      baseline.review?.testEvidence?.kind,
    ) ||
    !HASH.test(baseline.review?.testEvidence?.sha256 ?? '')
  )
    fail('missing explicit baseline review reference or provenance');
  validateEnvironment(environment, baseline.environment);
  if (receipt?.schemaVersion !== 1 || receipt.exitCode !== 0)
    fail('missing successful native runner receipt');
  validateEnvironment(environment, receipt.environment);
  for (const key of ['coverage', 'tests'])
    if (
      !HASH.test(reportHashes?.[key] ?? '') ||
      receipt.reportHashes?.[key] !== reportHashes[key]
    )
      fail(`stale ${key} report hash`);
  const sourceHashes = Object.fromEntries(
    Object.entries({ ...sources, ...tests }).map(([file, source]) => [
      file,
      sha(source),
    ]),
  );
  for (const key of ['sourceHashesBefore', 'sourceHashesAfter'])
    if (
      !object(receipt[key]) ||
      canonical(receipt[key]) !== canonical(sourceHashes)
    )
      fail(`source or test changed: ${key}`);
  const testCount = validateTests(testResults, tests, baseline.tests, root);
  const current = summarizeDesktopCoverage({ coverage, sources, root });
  for (const file of Object.keys(baseline.files))
    if (!Object.hasOwn(current, file))
      fail(`missing baseline source file ${file}`);
  for (const [file, actual] of Object.entries(current)) {
    const previous = baseline.files[file];
    if (!previous) {
      fail(`new source observations require explicit baseline review: ${file}`);
    }
    if (
      !HASH.test(previous.sourceSha256) ||
      !HASH.test(previous.mapSha256) ||
      previous.signatureVersion !== 'typescript-ast-sites-v2' ||
      !HASH.test(previous.structureSha256) ||
      !HASH.test(previous.instrumentationSha256) ||
      !object(previous.metrics) ||
      !object(previous.uncoveredSites)
    )
      fail('invalid baseline file evidence');
    if (actual.structureSha256 !== previous.structureSha256)
      fail(
        `source structure changed; explicit baseline review required: ${file}`,
      );
    if (actual.instrumentationSha256 !== previous.instrumentationSha256)
      fail(
        `instrumentation hints changed; explicit baseline review required: ${file}`,
      );
    if (actual.mapSha256 !== previous.mapSha256)
      fail(`coverage map changed for unchanged source structure ${file}`);
    for (const key of METRICS) {
      const recorded = previous.metrics[key];
      if (
        !integer(recorded?.total) ||
        !integer(recorded?.uncovered) ||
        recorded.uncovered > recorded.total ||
        !Array.isArray(previous.uncoveredSites[key]) ||
        previous.uncoveredSites[key].length !== recorded.uncovered
      )
        fail('invalid baseline metric');
      if (actual.metrics[key].uncovered > recorded.uncovered)
        fail(`increased uncovered ${key} count in ${file}`);
      assertSites(
        actual.uncoveredSites[key],
        previous.uncoveredSites[key],
        file,
        key,
      );
    }
  }
  return {
    files: Object.keys(current).length,
    tests: testCount,
    uncovered: Object.fromEntries(
      METRICS.map((key) => [
        key,
        Object.values(current).reduce(
          (sum, file) => sum + file.metrics[key].uncovered,
          0,
        ),
      ]),
    ),
    anomalies: {
      negativeBranchHits: Object.values(current).reduce(
        (sum, file) => sum + file.anomalies.negativeBranchHits,
        0,
      ),
    },
  };
}

function readBounded(file, maxBytes = 64 * 1024 * 1024) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    fail('input is not a bounded regular file');
  return readFileSync(file, 'utf8');
}

// Baselines remain reviewed files, never generated/updated by the runtime.
export function readCoverageBaseline(file) {
  const limit = 4 * 1024 * 1024;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    fail('baseline must be a bounded regular gzip file');
  const same = (actual) =>
    actual.isFile() &&
    actual.dev === info.dev &&
    actual.ino === info.ino &&
    actual.size === info.size &&
    actual.mtimeMs === info.mtimeMs &&
    actual.ctimeMs === info.ctimeMs;
  const fd = openSync(file, 'r');
  try {
    if (!same(fstatSync(fd))) fail('baseline changed before reading');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0,
      count;
    while (
      (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0
    ) {
      length += count;
      if (length > limit) fail('baseline compressed size changed');
    }
    if (!same(fstatSync(fd)) || !same(lstatSync(file)) || length !== info.size)
      fail('baseline changed while reading');
    return JSON.parse(
      gunzipSync(buffer.subarray(0, length), {
        maxOutputLength: 16 * 1024 * 1024,
      }).toString('utf8'),
    );
  } finally {
    closeSync(fd);
  }
}

export function sourceInventory(root) {
  const sources = {},
    tests = {};
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        fail('source symlinks require explicit review');
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const file = path.relative(root, full).split(path.sep).join('/');
      if (isSource(file)) sources[file] = readBounded(full, 2 * 1024 * 1024);
      if (isTest(file)) tests[file] = readBounded(full, 2 * 1024 * 1024);
    }
  }
  walk(path.join(root, 'src'));
  walk(path.join(root, 'scripts'));
  return { sources, tests };
}

function main(args) {
  const allowed = new Set([
    '--baseline',
    '--coverage',
    '--test-results',
    '--run-receipt',
    '--source-root',
  ]);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !allowed.has(args[i]) ||
      options[args[i]] ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      fail('only explicit read-only input arguments are supported');
    options[args[i]] = args[i + 1];
  }
  if (Object.keys(options).length !== allowed.size)
    fail('all read-only input arguments are required');
  const root = path.resolve(options['--source-root']);
  const ownRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  if (root !== path.join(ownRoot, 'packages', 'desktop'))
    fail('source root must be this checkout desktop package');
  const coverageBytes = readBounded(options['--coverage']);
  const testsBytes = readBounded(options['--test-results']);
  const environment = {
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    mapper: 'ast',
    vitest: JSON.parse(
      readBounded(path.join(ownRoot, 'node_modules/vitest/package.json')),
    ).version,
    coverageV8: JSON.parse(
      readBounded(
        path.join(ownRoot, 'node_modules/@vitest/coverage-v8/package.json'),
      ),
    ).version,
    configSha256: sha(readBounded(path.join(root, 'vitest.config.ts'))),
    lockSha256: sha(readBounded(path.join(ownRoot, 'package-lock.json'))),
  };
  const result = verifyDesktopCoverageRatchet({
    root,
    environment,
    ...sourceInventory(root),
    baseline: readCoverageBaseline(options['--baseline']),
    coverage: JSON.parse(coverageBytes),
    testResults: JSON.parse(testsBytes),
    receipt: JSON.parse(readBounded(options['--run-receipt'])),
    reportHashes: { coverage: sha(coverageBytes), tests: sha(testsBytes) },
  });
  console.log(`[desktop-coverage-ratchet] verified ${JSON.stringify(result)}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
