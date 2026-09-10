# 1.9.15 corresponding-source download recovery

## Actual failure retained

Formal run `34368758346`, source `69df4cb9b53faebeddc8fba58c54a74e0fb23018`, passed all 25 preflight jobs but failed `Build and verify corresponding source` on 2026-09-09 at 15:33:29 UTC. The original error was `official source download failed`. It did not record the input or HTTP status, so the historical failing URL is unknown. Installer construction, Windows acceptance, draft creation, deployment and publication did not run. The temporary publication OAuth copies were removed after the run reached its failed terminal state.

Subsequent local checks verified all 35 cached inputs against the unchanged source manifest. Normal TLS downloads independently retrieved 33 exact inputs; the two GNU license URLs returned HTTP 403. Node certificate-chain/time-out failures and successful Windows-system-TLS cross-checks were retained separately, not rewritten as successful Node requests or as proof of the historical macOS failure.

## Narrow correction

- Preserve `GNU-LGPL-3.0.txt` (7,652 bytes, SHA256 `e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118`) and `GNU-GPL-3.0.txt` (35,149 bytes, SHA256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`) verbatim under `scripts/licenses/`.
- Read these two licenses from the exact committed Git blobs, and verify the original length and hash. Missing or corrupted committed bytes fail closed; mutable checkout bytes and network fallback cannot replace them. The whole sidecar still requires clean HEAD before and after its build.
- Keep the canonical GNU URLs in the source inventory. `bundledLicenseSources` explicitly records `vendored-reviewed`, tracked paths and source commit; this is not a claim that the website download succeeded in this run.
- All other 33 source inputs, versions, hashes, allowed hosts, redirect limits, HTTPS verification and response-size limits remain unchanged.
- Failed HTTP downloads identify only the pinned public filename, hostname and status code. Response bodies, status text and signed redirect URLs are not logged; failed response bodies are canceled.

The license texts are independent corresponding-source materials, not extra application runtime payload. This correction does not waive desktop signing warnings, package-size limits, release acceptance or license-compliance review.

## Verification scope

Regression tests cover exact committed license bytes, dirty checkout rejection, missing/corrupt license rejection, refusal of altered expected hashes, unchanged non-license download handling, and HTTP 403/404/503 diagnostics. Existing URL, redirect, body-size, integrity and complete-Git-archive tests remain required. Real source-sidecar construction and the HEIC recombination probe remain mandatory release steps; a local or fixture pass is not proof of a published installer or production deployment.

## Windows test-facility follow-up (2026-09-10)

The first full script run retained 678 passes, three timeouts and four platform skips. Two real Git/disk-inventory cases passed with their original five-second budget in isolation but exceeded it under the full suite; these two cases now allow 15 seconds. The 8,193-file native NSIS pressure case exceeded its 15-second child-process budget twice. An independent timing probe observed the unchanged guard rejecting the directory after about 21 seconds with exit 73, `mainReached=false` and the expected inspection-limit reason. Only that pressure case now allows 45 seconds for execution and 60 seconds overall.

All assertions, the 8,192-file product limit, other fixture budgets and the actual packaged-installer 120-second acceptance limit are unchanged. Focused Git tests passed 20/20; the real NSIS pressure case passed. The subsequent full script run on Node 22.23.1 / Vitest 4.1.11 with the official NSIS compiler passed **681 tests, zero failures, four existing platform skips** (55 files, 159.54 seconds). Earlier failures remain separate records. Independent diff review, focused lint, code-map and whitespace checks passed. This is test-facility evidence, not actual packaged-installer or production acceptance.

## Deterministic survey-cache coverage (2026-09-10)

PR run `34376018669` on source `e3573d8dfd79474c658bd59174dbb4689930ae17` passed core and server tests. Its native macOS desktop run `b20ad9d8-e518-45c8-93f5-be7de239e54e` passed all 2,105 tests in 265 files, but the unchanged coverage gate correctly rejected new uncovered sites in `ParkServicesPlugin.tsx`. Comparing all 281 measured source files found only the cached-survey filter callback (line 471, statement/function) and the pending-account default label (line 527, branch); the other 280 files had no regression. Original raw report SHA256: `56625e9a9f1ed1552c0a6cc8452acfc76c9b8b7c69b77b2e28dfe391b573c446`. The failed receipt remains a failure, not an accepted baseline.

Two test-only cases now control these states explicitly. The warm-cache case waits for the actual background publication notification before opening the survey, includes both an announcement and a survey, and holds the session Promise until the UI proves it shows the survey and the default user label; releasing that Promise must populate the real fixture identity. The cold-cache case holds the publication Promise until the waiting UI is observed, then verifies the form after the receipt resolves. Both use the existing cache, component and event path, not mocked rendering or sleeps. The first cold-case draft attempted direct opening before park capability loaded and failed; using the visible service menu fixes that test setup without a product change.

All 67 focused park tests, renderer typecheck and focused lint pass. Product source, coverage baselines, verifier, thresholds, exclusions and time budgets are unchanged. Fresh full Windows/macOS measurements and a new formal release remain required; this section does not claim publication or deployment.
