# 1.9.16 scoped native-coverage review

PR: https://github.com/NSIETeam/otto-new/pull/80

The release owner reviewed the actual Windows and macOS measurements for the
1.9.16 feedback fixes. This is the user-authorized single-person emergency
engineering review, not an independent human approval or production acceptance.

Both original native runs passed all 2,161 assertions. Their mandatory gates
failed, and those failures and raw receipts are retained:

- macOS arm64: CI 34599540083, tested merge
  `6fe5577a676777bb9a47841a5c8305afca091f99`, native run
  `741fa26a-5a21-47d7-bb48-7159379ddc5f`.
- Windows x64: source/test bytes bound to `c2def97d`, native run
  `2746aee0-9a8d-4769-b17c-f97d623cf8e8`.

The lock difference is exactly three workspace version fields, 1.9.15 to
1.9.16. Dependencies, Node major, Vitest/V8 version, mapper, source scope,
configuration and gate rules are unchanged. The old reports are not rewritten
to pretend they passed a later baseline.

Only 17 changed/new business files receive reviewed observations. The other
266 baseline file entries and their uncovered-site budgets are retained, as
are all earlier provenance and required test paths. Per-file reasons, actual
metric changes, before/after entry hashes, native report hashes, original gate
failures and environment identities are in:

- `config/test-baselines/desktop/release-1916-win32-review.json`
- `config/test-baselines/desktop/release-1916-darwin-review.json`

The unchanged module-group dialog had one newly unobserved branch because
recruitment is no longer an all-enabled template. Its baseline is **not**
relaxed. An explicit all-enabled park-template test now checks that branch,
independently of the removed recruitment group.

Additional assertions check invalid/oversized policy model output, input limits
before model-chat allocation, invalid/failed/unknown/exhausted task execution,
no replay even when cancellation fails, and distinct network, model-unavailable,
timeout and cancellation messages. The five focused files pass 35 assertions.

Known coverage debt remains in the Electron bootstrap, default model auth setup,
preview bridge and some UI callbacks. The separate actual Electron transparency
probe is not represented as unit coverage. These measurements do not prove model
answer quality, live server acceptance or every historical installation layout.
Full final-source Windows and macOS runs must pass the unchanged mandatory gate
before publication.
