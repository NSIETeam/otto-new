# Artifact-only dependency download recovery

Journey: build all three diagnostic installers from the approved 1.9.20 source
without allowing npm lifecycle scripts to see a GitHub credential, disabling
hooks permanently, weakening hashes, or reaching a publication environment.

## Reproduced failure

In artifact-only run `37446598656` on source
`550f9ea5de447f290c60268a45377b337fca3420`, Windows job `112217208421`
and macOS ARM job `112217208378` failed in `npm ci`: the upstream
`@vscode/ripgrep` installer repeatedly received HTTP 403 while querying the
GitHub release API. All five SQLCipher targets and both source-bound matrix
attestations had succeeded. This was not a formal release or application
runtime failure. The macOS x64 job was still running when this report was written.

## RED / GREEN

Command, run with cached Node 22.23.1:

```text
node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts scripts/tests/desktop-packaging-validation.test.js --coverage.enabled=false --reporter=dot
```

- `93ee087c`: RED, one new regression failed; nine existing tests passed.
- `ee652854`: GREEN, the same target passed all ten tests.
- Expanded proof passed eleven tests: it executes the actual inline Windows
  bootstrap, checks the destination bytes, and rejects a wrong digest, an
  existing destination and a directory link. Fixture hashes/binaries are
  synthetic and isolated; this is not upstream executable provenance evidence.

## Smallest correction

macOS uses the existing reviewed archive-and-executable cache before `npm ci`.
Windows first materializes the unchanged lockfile without hooks, obtains and
verifies the existing reviewed upstream binary, copies it without overwrite,
then runs **all** rebuild hooks and the root postinstall. All hosts verify the
installed ripgrep digest and version afterwards. No credential is passed to
npm or its hooks. The release workflow, installer/ASAR ceilings, native probes,
seals, provenance and publication protections are unchanged.

## Verification and remaining admission

Seven focused release/workflow suites passed **67 tests**, including the eleven
diagnostic workflow tests. Doctor passed at **54.53 MB / 55 MB**, code-map check,
changed-test ESLint and whitespace checks passed. The YAML branch/ordering
contract and both inline link-guard branches were exercised; these results are
not a whole-application coverage percentage or actual installer acceptance.

A fresh merged-source artifact-only run must still build and verify **all three
actual installers**, and the actual packaged UI and five successive Word outputs
must pass before installing temporary credentials or dispatching the one
authorized formal release. No version increment, production credential,
approval change, paid model request or formal release occurred in this fix.
