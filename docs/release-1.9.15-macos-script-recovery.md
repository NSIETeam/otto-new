# 1.9.15 macOS release-script recovery

## Retained failure

Formal run `34428869059`, source `64e31ecd881d6986a67abadea928ba3b98c1e0e9`, failed before packaging on 2026-09-10. All 25 preflights and the real corresponding-source/recombination step succeeded. The native Desktop run passed 2,107 tests and its 281-file coverage gate. The **separate scripts suite** failed: 646 passed, 30 failed and 25 platform skips across 701 cases. Installer construction, release drafts and deployment did not execute. These facts do not constitute a completed release.

## Corrections and preserved boundaries

- Canonicalize test-owned temporary base directories before constructing baseline, experiment, coverage and systemd fixtures. macOS exposes `/var` through `/private/var`; an implicit fixture alias must not be confused with an explicit user-created link. Product link rejection is unchanged. Negative tests continue to reject linked inputs, outputs and evidence; sentinels verify no unintended writes.
- Fix the corresponding-source builder itself: resolve the nearest existing output/cache ancestor before comparing it with the real checkout, including not-yet-created child directories. Use those canonical paths and recheck before output writes. A checkout reached through an alias is still inside the checkout. Existing files, dangling links and changed directory identities fail closed. The original timeout was an unintended network path after a missed containment check, not a reason to increase the test timeout.
- Make PostgreSQL prefix/version rejection explicit in both CI and release setup. Do not rely on old Bash applying `errexit` to a false compound conditional. Preserve the required PostgreSQL 17 formula, exact version pattern, isolated-cluster opt-in and refusal of invalid paths. Tests also exercise a context where implicit `errexit` is suppressed.
- Preserve the installer configuration's missing-versus-empty distinction with Bash-compatible indirect variable inspection. Empty or malformed configuration still fails; no new permission or configuration default is introduced.
- Add the **entire scripts suite** to mandatory macOS PR CI before the long native build. Previously the PR ran Desktop and other suites but not this full script gate, so a green PR was insufficient evidence for it. Formal release still runs its full quality gate independently.

## Verification limits

Local Node 22.23.1 / npm 10.9.8 on Windows: the final complete scripts run reported 711 passes, zero failures and four existing platform skips (715 cases). Focused path/source transport tests passed 37/37; canonical fixture tests passed 53/53; Shell/PostgreSQL tests passed 79/79. The new alias and explicit-exit cases failed before their respective product fixes. Full lint, doctor and code-map/diff checks passed. Fixed Windows and macOS Desktop coverage-baseline bytes were unchanged. The repository disables Issues, so this blocker is tracked in the repair PR and this document instead.

The regression tests exercise real temporary filesystem aliases/junctions and extracted Shell setup code without installing services, using production credentials or downloading source artifacts. Local Windows results are not a claim about native macOS behavior; the mandatory macOS CI and fresh release must pass on their actual runners. No fixed Desktop coverage baseline, package-size limit, signature/provenance check, installer guard or production restart policy is weakened by these corrections.
