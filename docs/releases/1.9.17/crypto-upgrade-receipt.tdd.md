# Windows encrypted upgrade receipt verification

## User guarantee

Before publishing the migration release, install the historical baseline, seed
synthetic OS-protected state, install the candidate, and verify unchanged device
identity, key inventory, MLS group, encrypted history, pending outbox and pinned
trust. A successful receipt must be bound to physical installed artifact hashes.
No missing receipt, timeout or incomplete check is a pass.

## Findings and fixes

The fourth release candidate completed the assertions but failed when generating
the receipt. Two test-harness issues obscured the cause:

1. The GUI Electron child lacked explicit output pipes. Diagnostics now use
   fixed stage names; arbitrary assertion values, keys and history are not logged.
2. Electron virtualizes `.asar` paths. The hash function now uses `original-fs`
   in Electron to read physical bytes. It does not set `process.noAsar` and does
   not modify installed files or change cryptographic assertions.

[Electron's ASAR checksum documentation](https://www.electronjs.org/docs/latest/tutorial/asar-archives#treating-an-asar-archive-as-a-normal-file)
describes this distinction.

## RED / GREEN evidence

| Guarantee                                                                   | RED checkpoint / result                                                             | GREEN checkpoint / result                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| Fixed, non-secret failure stages and GUI pipes                              | `a3f5df75`: two new tests fail; six existing admission tests pass                   | `bed5473d`: same eight pass                     |
| Physical ASAR hash in real Electron, virtual archive reads remain available | `80895dab`: existing synthetic archive fails `digest:ENOENT`; nine other tests pass | `fba695b6`: same ten pass under Electron 43.2.0 |

Validation uses locked Node 22.23.1 and Vitest:

```text
node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts scripts/tests/windows-crypto-upgrade.test.js
```

The real Electron checks are mandatory in the dedicated Windows CI job via
`OTTO_REQUIRE_ELECTRON_PROBE_ENTRY=1`. Non-Windows environments do not replace
that hosted result. Local real-host tests create only synthetic temporary files;
the complete installed-app probe refuses workstation execution.

## Same-candidate hosted verification

A temporary read-only PR workflow reproduced the exact installer from release
run `35545865735`, source `a412c4e39c2199734a7fe219f1834213faf1dbe1`, with SHA-256
`3f28953d9e0c91fb71f912bb0cb6c5bf28c5efd0bd4a5ad82c0c86eadd9938cd`.
It had no production environment, no production credentials and no write
permissions. It never published or deployed.

- Before the hash fix: run `35548981874` failed at `verified-receipt` after all
  continuity assertions.
- After the hash fix: run `35549485211` succeeded. It performed a real
  **1.9.14 → 1.9.17** installation and emitted `verified.json` with all six
  continuity flags true and Electron host 43.2.0.
- Probe source was synthetic PR merge `498f3839652fe79e9245ccf2fe9738db6a174525`,
  tree `93d26aa8f3553a7cb6933be01d8ad5849ec33265`.
- Receipt SHA-256: `41eb93c09cece827c07e99410d53bff5be3d4c25cd19a3add36ef25d86b8cb13`.
- Installed archive SHA-256: `ce8124c72feb41b6313fd3beedd9518d70a3e4804d78e95595842901fd9a82ee`.

The incident-specific workflow and its routing-only contract test were removed
after collecting this evidence, so expiring prior-run artifacts cannot become a
permanent CI dependency. The real Electron checksum regression and every formal
release installation, cryptographic and publication gate remain in place.

This does not prove GUI login, all historical versions, customer production
datasets or commercially signed device-policy compatibility. A new formal
release must still test its own exact candidate; these receipts cannot substitute
for that run's acceptance or authorize its production approval.
