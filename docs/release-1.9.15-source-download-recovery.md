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
