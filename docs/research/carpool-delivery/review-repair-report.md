# 复审四项修复与验收

基线 `7c4d016f`，目标本地分支 `codex/blue-heron-7f3a9c`。测试执行目录 `/tmp/otto-carpool-repair-91bc4e`。最终源码目录 `/Users/yang/Desktop/otto-carpool-fixed-91bc4e`。原混合目录完整保留在 `codex/preserved-market-91bc4e` 分支，不覆盖其文件。没有推送、部署或混入跳蚤市场改动。

## 修复结果

| 编号 | 改动及证据 | 结论 |
|---|---|---|
| R1 | 暂停写入时跳过密钥初始化写入和 outbox 重试；单条 append 失败返回可见错误并保留可读历史。真实 SQLite + Native 验证暂停前已有消息、加密后暂停、重试期间暂停、初始密钥尚未就绪、恢复后幂等投递。 | 已修复，本地真实链路通过 |
| R2 | 原企业 MLS 不再 await 拼车 activate/close。独立可取消启动任务先验证获批设备及服务端权限/能力，10 秒取消启动预算，身份变更立即取消轮询、迟到结果不启动，失效后不继续补密钥库存。永不返回的旧权限检查/初始化/清理不阻断其他身份，迟到旧任务只能清理自己的实例。 | 代码与故障隔离/取消/超时回归通过；完整产品正式登录时延未真机实测 |
| R3 | production 或未设置 NODE_ENV 默认关闭新请求/邀请/多人，显式开启才公布能力；test/development 保持开发便利。Electron 验收脚本显式启用测试能力。 | 缺省/逐阶段/依赖门禁回归通过；未启用生产 |
| R4 | 对旧园区可用模块执行追加迁移，记录已处理模块，不重新排序、不搬移跨组模块；权限恢复后只补首次可用模块，用户移除不重加。 | 无拼车权限、普通/官方组、跨组保留、授权恢复、移除后重新读取等布局回归通过 |

旧布局没有历史迁移标记时无法判断某个缺失的旧模块是从未安装还是很早以前移除。本次明确沿用旧系统“补齐可用模块”的契约，仅对这些旧模块做一次追加，然后永久记录该模块已处理。拼车入口自身的既有移除标记不重置，也不把旧布局恢复成固定排序。

## 执行结果与证据

- [服务器专项](evidence/repair-server-tests.log)：17 文件、95 项通过；开启真实 PostgreSQL 17，另含真实 SQLite、状态机和配置门禁。
- [桌面专项](evidence/repair-desktop-tests.log)：9 文件、47 项通过；包括完整 React 用户旅程、真实 SQLite/Native、启动故障隔离及布局。
- [原桌面回归](evidence/repair-regression.log)：11 文件、180 项通过；企业私聊、E2EE/MLS、附件、联邦、Inbox、模块布局。
- [Electron](evidence/repair-electron.log)：真实窗口、签名 HTTP、SQLite、Native MLS、macOS safeStorage 通过。仍使用显式地图 fixture/测试身份，不冒充正式部署。
- [server 类型](evidence/repair-server-types.log)、[desktop 类型](evidence/repair-desktop-types.log)、[server 构建](evidence/repair-server-build.log)、[desktop 构建](evidence/repair-desktop-build.log)、[lint](evidence/repair-lint.log)通过。
- [doctor](evidence/repair-doctor.log)、[code-map](evidence/repair-code-map.log)、Git diff whitespace 检查通过。
- [边界检查](evidence/repair-boundaries.log)仍因既有 policyIntelligencePresentation.test.ts 深层导入失败；本次未改无关测试或门禁。

对应命令（从修复根目录运行，desktop 测试在 packages/desktop）：
```
OTTO_CARPOOL_POSTGRES_TEST=1 npx vitest run --config packages/server/vitest.config.ts packages/server/src/modules/park_carpool packages/server/src/enterprise/parkCarpoolRoutes.test.ts
# packages/desktop cwd
npx vitest run src/renderer/components/Carpool src/renderer/components/ParkCarpoolDialog.test.tsx src/renderer/parkCarpool src/main/park-carpool src/renderer/moduleWorkspace.test.ts
npx vitest run src/renderer/moduleWorkspace.test.ts src/renderer/moduleModal.test.ts src/renderer/components/InboxPage.test.tsx src/main/enterprise-client.test.ts src/main/enterprise-e2ee.test.ts src/main/enterprise-mls.test.ts src/main/enterprise-mls-attachments.test.ts src/main/enterprise-mls-private-messages.test.ts src/main/federation-atoa-protocol.test.ts src/main/federation-atoa-tasks.test.ts src/renderer/federationAtoaProtocol.test.ts
# root cwd
node packages/desktop/scripts/carpool-acceptance/electron-smoke.mjs
npm run typecheck --workspace=packages/server
npm run typecheck --workspace=packages/desktop
npm run build --workspace=packages/server
npm run build --workspace=packages/desktop
npm run doctor
npm run code-map
npm run code-map:check
npm run validate:boundaries
```

Lint 对本次 11 个修改/新增 TS、TSX、MJS 源码和测试执行 `npx eslint --no-ignore <files> --max-warnings 0`，包含通常被默认忽略的 Electron 验收脚本。失败→修复证据保留为 repair-*-red.log；日志仅去掉行尾空白与末尾空行。

## 自查与验收边界

本轮四项问题的本地工程复验通过。未修改企业原生加密隔离、核心业务规则、依赖锁或其他模块数据库。启动隔离有延迟 Promise、权限失败、身份取消和超时回归，实际 main 调用已移出 await 链，但没有将这些测试描述为正式登录服务器的整机故障注入验收。

真实高德许可/道路质量、系统定位、Windows、正式企业登录、多节点、生产 SQLCipher 与备份恢复仍未实测，保持原报告状态。不能据本轮修复宣称完整生产上线验收通过。

独立复核追加发现并修复了旧任务超时仍占全局队列的问题，新增 repair-stuck-red.log 及两个永久挂起回归。现在超时/取消通过 Promise.race 结束本次启动等待，实例按尝试隔离；同一设备的旧加密文件 IO 未清理完时仍暂缓同设备重建，以避免并发写坏文件，其他身份不等待它。底层请求仍遵守原有超时，极端本地 IO 永久挂起时同设备需要重启 App，不能声称强行中断所有 OS IO。

最终独立只读复核：R2 阻断已消除，复核者实跑启动专项 5 项通过，未发现本轮新增明确阻断。
