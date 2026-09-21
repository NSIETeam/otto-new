# Restored-session tool loading — TDD evidence

## Source and user journey

No plan file was provided. The journey was derived from the reported Otto desktop screenshot:

> As an Otto user reopening a persisted conversation after a server or desktop restart, I want the Tools panel to initialize that conversation on demand, so that I can inspect available built-in and MCP tools without sending a throwaway message first.

## RED → GREEN report

| Stage | Commit | Command | Result | Evidence |
| --- | --- | --- | --- | --- |
| RED reproducer | `1e104542` | `npm test --workspace=packages/server -- server.test.ts -t "服务器重启后读取旧会话工具清单"` | Expected failure | The server returned `error/no_session`; the test expected `tools_list`. |
| Minimal fix | `fc21e65f` | Same focused command | PASS | 1 targeted test passed. |
| Boundary expansion | `55b55a7d` | `npm test --workspace=packages/server -- server.test.ts -t "工具清单\|工具面板"` | PASS | 3 tests passed: restored-session success, missing/forbidden fail-closed, initialization failure is retryable. |

## Test specification

| # | What is guaranteed | Test | Type | Result |
| --- | --- | --- | --- | --- |
| 1 | A persisted session with no in-memory runtime lazily creates exactly one runtime and returns its tools. | `server.test.ts`: “服务器重启后读取旧会话工具清单…” | WebSocket integration | PASS |
| 2 | Missing and unauthorized sessions are rejected before any runtime factory call. | `server.test.ts`: “读取不存在或无权限会话…” | Authorization integration | PASS |
| 3 | Runtime construction failure returns `get_tools_failed` to the requesting panel and does not attach a partial runtime. | `server.test.ts`: “旧会话 runtime 初始化失败…” | Error-path integration | PASS |

## Additional validation

- `npm run typecheck --workspace=packages/server` — PASS.
- `npx --no-install eslint packages/server/src/server.ts packages/server/src/server.test.ts --max-warnings 0` — PASS.
- `npm test --workspace=packages/server -- server.test.ts` — 240/240 discovered tests PASS across 3 files.
- `npx --no-install vitest run packages/server/src/server.test.ts --config packages/server/vitest.config.ts --coverage --coverage.include=packages/server/src/server.ts` — 89/89 tests PASS.
- Changed production statements and branches in `handleGetTools` were all executed by the coverage run (statement counts were non-zero; both new branch alternatives were exercised).
- Full server suite: 3039 PASS, 33 skipped, 26 failed. Every failure reported the same unavailable local prerequisite: `initdb`, `postgres`, and `pg_ctl` were not installed or configured. No failure referenced the changed session/tool path.

## Coverage and known gaps

The focused `server.ts` file report is 51.11% statements, 42.76% branches, 45.56% functions, and 51.56% lines because `server.ts` is a large pre-existing server containing many unrelated routes. This does not meet an 80% whole-file threshold. The changed production path itself has full statement and branch execution evidence. PostgreSQL-backed market tests must run in CI or on a host with `OTTO_TEST_POSTGRES_BIN` configured before release.

## Merge evidence

Keep the RED and GREEN commit identities in the PR body if the branch is later squashed. A release must not be cut until CI supplies the missing PostgreSQL test evidence.
