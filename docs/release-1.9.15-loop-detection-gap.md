# 1.9.15: distant content-loop false positive

Formal run `34481804722`, source `b4d2183396bb1a7ffb45f1583e634ad9ab224b2f`,
failed the Core far-apart repetition test before packaging or deployment.
The original job log SHA-256 is
`4769980c426923e7ac07742a47ca4e4a4d886100c0a1b9682b7a3506fe209e31`.
The run did not retain its randomly generated filler; the following is a
deterministic reproduction of the faulty mechanism, not recovered random input.

A 500-character `b` burst next to a filler starting or ending in `b` produces
overlapping identical windows only one character apart. Averaging those short
gaps with the roughly 1,000-character gaps between bursts falsely satisfies the
750-character proximity threshold. The leading-boundary case triggers at
character 9,501, before history truncation, so truncation is not necessary to
reproduce the bug.

The detector now requires every adjacent gap among the latest 20 matching
windows to meet the existing chunk-type limit. No threshold, history bound,
tool-call guard, permission gate, dependency or release workflow is loosened.
This deliberately changes an average-proximity heuristic into a consecutive
nearby-cluster heuristic; it is not a general proof of whether an agent is stuck.

Tests use fixed SHA-derived text instead of unrecorded randomness. Seven added
cases cover leading/trailing/both matching boundaries, character/137/1,000-byte
event splits, history truncation, sparse-to-dense recovery, and the exact
750/751-character gap boundary. Six fail against the original implementation;
all seven pass after the fix. All 23 loop tests pass, including unchanged
continuous-content and standard/preview tool-loop protections. The related
kernel-boundary suite passes 247 tests with one existing platform skip.

These focused results are not Windows upgrade, enterprise deployment, or public
release acceptance. Those gates must still run on the new immutable source.
