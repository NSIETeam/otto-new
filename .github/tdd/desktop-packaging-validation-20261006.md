# Artifact-only packaging validation before another release approval

Journey: verify actual Windows/macOS bundle sizes after the duplicate-tokenizer
fix without consuming another single-use production approval or exposing an
unvalidated version to existing clients.

## TDD evidence

- RED checkpoint `72bd160e636b0d303f7dcbffcee227ccab521b2c`, reachable on the
  active `fix/1.9.19-packaging-size-20261006` branch: 7 tests executed and failed
  because the dedicated no-publication validation workflow did not exist.
  An earlier cached-Node permission failure did not execute tests and does not
  count as RED.
- GREEN command, repository root, Node 22.23.1 / Vitest 4.1.11:

  ```text
  npx --offline --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts scripts/tests/desktop-packaging-validation.test.js scripts/tests/workflow-actions-contract.test.js
  ```

  Result: 2 files / 9 tests passed. The same 7 new tests and 2 existing global
  action-pin checks passed. Test lint, diff whitespace and code-map checks passed.

## Guarantees and limits

| Guarantee                                                                                     | Evidence                                        | Type                                                        |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Only manual latest-internal source admission; checkout does not retain credentials            | Dedicated workflow test                         | YAML contract                                               |
| SQLCipher matrix/manifest build identity and attestations required                            | Same test, existing reusable native workflow    | YAML contract; native execution remains cloud validation    |
| Native Windows NSIS / Intel and ARM macOS DMG builders use current-source Otto native runtime | Same test                                       | YAML contract                                               |
| Formal installer budgets and 120 MiB ASAR limit unchanged; real probes and seals invoked      | Same test plus existing 73-test packaging suite | Contract, budget units and existing runtime implementations |
| No release, tag, update feed, production environment or production secret usage               | Dedicated workflow test                         | YAML contract                                               |
| Only diagnostic installer/receipt artifacts, explicitly no install/upgrade claim              | Same test                                       | YAML contract                                               |

The workflow adds no application code or new runtime helper. Coverage of the
changed content checker was measured separately at >80% on all dimensions in
[packaging-size-20261006.md](packaging-size-20261006.md). YAML contract tests are
not proof of a successful cloud build. Three source-bound actual bundle
receipts, followed by the protected formal installation/upgrade gates, are
still required. No byte budget, permission protection, license check or release
exception is relaxed. No additional model request is made.

This validation workflow uses the standard read-only repository job token for
attestation lookup; only the existing native attestation job receives scoped
OIDC/attestation write permission. It receives no custom production credential,
does not alter environment protection, and cannot publish a release. Another
formal release requires renewed single-run approval; the failed run must not be
rerun.
