# 1.9.21 deterministic Skill zone response coverage

## Scope and RED evidence

Journey: after leaving My Skills, delayed local/shared responses must not
replace the current market or pollute a later My Skills visit.

Fresh CI 37556549839, attempt 1, candidate
34c1cf8ab1e5bf36469dd950f5f46ef7092bb78d: all 2,249 desktop assertions passed,
native exit 0, but the unchanged coverage ratchet failed SkillZonePage's
uncovered branches (60 versus the reviewed macOS budget of 57). The three
missing arms are the stale-request guards for local results, local finally,
and shared results (lines 125, 128, 130). Comparing the raw report with CI
37548290964 confirms identical branch maps. Their incidental coverage used
to depend on whether an action's refresh finished before navigating away.
Raw test SHA-256: 66c491d2d271c8e5f2f84ac4e7c1f133ccd37ede1ec8862f10674684817713be.
Raw coverage SHA-256: f5393d0cbc331a9afc6fa8e650ecd9cf717d27b28c4e8a5cdba29467fa414da6.

## Test-only repair and focused GREEN

`SkillZonePage.test.tsx` explicitly holds both My Skills responses until the
current market has rendered, releases them inside `act`, verifies the market
is unchanged, and re-enters My Skills to verify fresh local/shared data.
The existing submit/review test now waits for each user-visible success
status, not just invocation of the mock bridge.

Actual focused Node 22 / Vitest 4.1.11 command:
`vitest run src/renderer/components/SkillZonePage.test.tsx`: 7 passed,
1 file, zero failures. No production branch was changed; RED is the actual
coverage gate regression above, not an artificial failing assertion.

Coverage baselines, budgets, required test inventory, timeouts, retry policy,
security exceptions and historical evidence remain unchanged. Fresh full
Windows/macOS coverage and all release/package gates remain mandatory;
the focused pass does not claim release acceptance.
