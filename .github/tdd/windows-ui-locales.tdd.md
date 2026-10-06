# Windows UI locale packaging recovery (1.9.20)

## Journey and observed failure

As a desktop user, I need the security-patched Windows installer to retain
Chinese and English UI, international text handling, native runtimes and
licenses while satisfying the unchanged delivery size gate.

Artifact-only run `37453208690`, exact source
`0a1944e0d081248bb9a1b6ed998ebe804b8a3e93`, built a Windows installer of
137,619,286 bytes, above the unchanged 136,421,279-byte ceiling. Its SHA-256 is
`0278569f56667d0615e71259199fc389c17d4c61281538f9fa8e9ec893dc80ee`.
Both macOS diagnostic package jobs passed; no release was published.

Listing that actual installer and the frozen 1.9.18 installer with pinned
7-Zip showed Electron shell files grew from 82,459,975 to 87,754,085 compressed
bytes, while application resources shrank from 42,722,035 to 40,511,041 bytes.
Windows still carried all Chromium UI locale files (8,631,578 compressed bytes);
macOS already explicitly limits its UI languages to Chinese and English.

## RED and GREEN

Tests were added to `packages/desktop/scripts/packaging-contract.test.mjs` before
the package configuration changed. They normalize the actual installed
electron-builder configuration and execute its real `beforeCopyExtraFiles`
hook against an isolated filesystem fixture, rather than duplicating the
builder's locale filtering algorithm.

| Guarantee | Evidence | Result |
| --- | --- | --- |
| Windows explicitly retains en-US, en-GB, zh-CN and zh-TW | Normalized builder configuration | RED: missing configuration; GREEN: all four retained |
| Unused Windows UI translations are removed | Real builder hook with French, German and Japanese UI resources | RED: resources incorrectly retained; GREEN: absent |
| ICU, native/runtime data and license notices remain byte-identical | Same real hook, protected fixture resources | PASS |
| Existing ASAR runtime, license, tokenizer and size rules remain intact | Four focused packaging suites | 75 tests PASS |

RED command (Node 22.23.1):

```text
node ../../node_modules/vitest/vitest.mjs run scripts/packaging-contract.test.mjs --coverage.enabled=false --reporter=dot
```

Observed: 2 new failures and 42 existing tests passed. Checkpoint `f5ae4374`.

GREEN reran the identical reproducer plus `verify-packaged-content.test.mjs`,
`packaging-tokenizer.test.mjs` and `installer-size-budget.test.mjs`: 75 tests
passed across four files. Checkpoint `0eb800f8` changes only the Windows
`electronLanguages` configuration.

## Coverage and remaining release proof

This is a declarative package configuration change, not new application logic;
both new guarantees execute the real installed builder. Full desktop coverage
and its existing per-file ratchet remain mandatory in CI, without threshold
changes. The new actual installer must still be rebuilt and measured; estimated
resource savings are not an acceptance result. Runtime/UI, consecutive actual
Word files, real Windows installation/upgrade, signing-integrity, deployment,
canary and rollback gates remain mandatory. Version stays 1.9.20; no paid model
requests are added. This change does not alter ICU, language understanding,
document content/fonts, any native runtime or licensing files.
