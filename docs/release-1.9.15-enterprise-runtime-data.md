# 1.9.15 enterprise runtime data packaging

Formal run `34473630150`, source
`d84a642bf45734708a60d0b616abd6f9782f86cf`, passed desktop packaging and
installer size gates but failed the enterprise package's offline startup.
`policySources.js` could not import `policy-sources.json`: the enterprise copy
list admitted only JavaScript, although the workspace build had copied the JSON
correctly. A second production import, `enterpriseIndustryTaxonomy.json`, had
the same defect and supplies enterprise profile/partnership industry data.

The fix explicitly includes those two data files, preserving the existing
missing-file failure and manifest hashing. It does not admit arbitrary JSON,
fixture databases, source maps or declarations, and does not change business
logic, dependencies, signatures, deployment gateways or installer size budgets.

Regression tests execute the actual builder's file enumeration and copy block
in an isolated filesystem. Native Node ESM then resolves both production JSON
import statements against byte-identical real data. The test also removes each
required asset in turn and checks exclusion of unrelated development data.
Before the fix: three failures and one pass. After the fix: all four asset tests
pass; the combined asset/dependency/workflow run has 14 passes, zero failures
and one existing platform-dependent dependency-copy skip. These tests do not claim
to start the full enterprise server; both existing full-runtime and extracted
archive startup checks remain mandatory in the actual release build.

Local verification uses Node 22.23.1 and npm 10.9.8, with focused asset,
dependency, workflow and provenance regressions, syntax/lint, doctor,
`git diff --check` and code-map verification. No TypeScript changed. This is
packaging regression evidence, not production acceptance or publication.
