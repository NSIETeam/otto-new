# 1.9.19 duplicate tokenizer payload correction

Source journey: a user upgrading an old Otto client must receive the same runtime capabilities without an installer exceeding the existing release byte budget. This task follows the failed pre-publication run [37419109264](https://github.com/NSIETeam/otto-new/actions/runs/37419109264), source `b24160a06f521a9a1833acd6d162e73e715a54ca`.

## Observed failure and scope

- Windows installer: 138,973,025 bytes > 136,421,279 bytes.
- macOS x64 DMG: 169,617,323 bytes > 167,772,160 bytes.
- No 1.9.19 tag, draft, public release, enterprise deployment or mirror change was reached. Public canonical/compatibility latest and production health were subsequently rechecked at 1.9.18.
- Task-created temporary credentials were deleted and self-approval prevention restored. Another production approval is not authorized by this evidence report.
- The repository has disabled GitHub issues; the attempted issue creation did not succeed. Acceptance criteria and evidence are preserved here and in the pull request instead of changing repository settings.

Primary installed builder code shows NSIS already uses 7z level 9 and UDZO already uses level 9. Root `compression: maximum` would change DMG to UDBZ; this patch does not do that. The locked application's only `js-tiktoken` consumers are LangChain's ESM/CJS helpers importing `js-tiktoken/lite`, whose ranks are loaded separately. The full ESM index embeds all six word-rank tables, while the rank JS files repeat that payload. Those seven files are unreferenced by the current application. No dependency, native offline tokenizer, document runtime, license, installer identity or compression format is removed or changed.

## TDD checkpoints

- RED checkpoint: `eeea9a55`, reachable on `fix/1.9.19-packaging-size-20261006`.
- Real desktop Vitest executed 5 tests: 4 failed / 1 passed. Both normalized platform filters included the unused full index; the content checker did not reject duplicate rank files; the real filtered package still carried those copies. Budget assertions passed. A preceding run from the wrong test root found no tests and is not counted as RED evidence.
- GREEN: two exact dependency exclusions plus a nested-path-aware content rejection, preserving the lite entry, shared implementation and licenses. The exact same five regressions passed. Additional tests cover invalid byte budgets, real CLI entry points, compiler-output roots and bounded violation previews.

Commands executed from `packages/desktop` using Node 22.23.1 / Vitest 4.1.11:

```text
npx --offline --yes --package=node@22.23.1 node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts scripts/packaging-tokenizer.test.mjs scripts/verify-packaged-content.test.mjs scripts/packaging-contract.test.mjs scripts/installer-size-budget.test.mjs --coverage --coverage.include=scripts/verify-packaged-content.mjs --coverage.reporter=text --coverage.reporter=json
```

Result: 4 files / 73 tests passed. Changed checker coverage: statements 86.25%, branches 85.18%, functions 88.88%, lines 85.71%. The subprocess CLI was also executed, but subprocess execution is not represented as parent-process V8 coverage. Existing coverage ratchets are unchanged.

| Guarantee | Evidence | Scope |
| --- | --- | --- |
| Both platform dependency filters omit only unused full/rank JS bundles, including nested copies | `packaging-tokenizer.test.mjs` | Real installed builder config normalization |
| Lite, shared JS, metadata, licenses and other libraries' index/ranks remain | Same test | Positive and negative path cases |
| Copied locked lite package encodes/decodes synthetic UTF-8 using separately supplied ranks | Same test | Fresh subprocess, no checkout module resolution or network requests |
| Accidental duplicate reintroduction blocks the content gate | Same test | Static entries and full existing ASAR checker tests |
| Windows/macOS/ASAR budgets and installer identities are not loosened | Existing budget and packaging contract suites | Original limits retained |

Focused script lint, `git diff --check`, doctor and code-map drift check passed. Explicit script lint used `--no-ignore --global console` because the repository's ordinary lint target ignores desktop script MJS files; it did not suppress any rule.

## Actual installer proof remains separate

The seven unused files total 11,198,747 uncompressed bytes. A diagnostic archive using the installed builder's reviewed 7zip tool/NSIS-style level-9, 1 MiB, non-solid settings measured 3,574,224 bytes. That is only a component measurement, not proof of the final ASAR/installer size. Final Windows/macOS builds, actual install/upgrade acceptance and all formal publication gates must pass against the newly locked source before release. No new paid model request was made for this packaging fix; the prior six-call budget is exhausted.
