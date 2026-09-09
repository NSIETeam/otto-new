# 拼车任务自查与验收报告

日期：2026-09-08。仓库：`/Users/yang/Desktop/otto-new`。

**结论：整体验收不通过。阶段一部分实现，阶段二与阶段三未实现。本次修改不是完整 PRD 交付。** 实施任务要求持续补齐全部阶段；当前工作未达到这个目标，不能因下述测试通过而关闭任务。

## 实际交付与未交付

| 阶段 | 实際落地 | 仍缺少的内部实现 |
|---|---|---|
| 一 | 个人发布/匹配缺陷修复、北京时间校验、候选住宅标签隐藏、幂等及 CAS、SQLite/PG 原子回执、主动确认、对话字段与草稿恢复、页面状态与筛选 | 管理员集合点、定位/逆编码/地图选点、结构化安全区域、脱敏路线对比、消息请求与授权私聊、屏蔽举报及处理台、消息中心状态卡、可靠通知、数据清理、完整无障碍 |
| 二 | 没有可验收的新功能 | 结构化邀请、实际方式与司机、容量、接受事务、两人组与成员、拒绝撤回冷却失效、停止/退出分流、真实能力开关 |
| 三 | 没有可验收的新功能 | 组候选与公式/绕行、申请/容量事务、单人单组、转交、退出归档、多人园区会话、成员密钥更新、加入/离开历史限制 |

这些内部缺口不是缺凭据导致，不能被列为“代码完成但外部阻塞”。本次实施停留在基础纠错和可靠性层，尚未建设完整业务及园区沟通协议。完整需求逐项状态见 `acceptance-matrix.md`（367 个 PRD 原文条目及 17 项补充规则）。

## 实际检查与命令

以下命令在仓库根目录运行，除桌面 Vitest 特别注明外。原始输出保存在 `evidence/`。

| 检查 | 命令 | 结果与证据 |
|---|---|---|
| 基线/最终 doctor | `npm run doctor` | 失败。开始 60.68 MB，最终记录见 doctor-final.log，源码预算 50 MB；未抬高预算/删除用户文件 |
| Diff | `git diff --check` | 通过；diffcheck.log（成功无输出） |
| 服务端相关回归 | 下方完整命令 | 11 文件、107 测试通过；server-regression.log |
| 桌面相关回归 | 下方完整命令 | 11 文件、102 测试通过；desktop-regression.log |
| 原生 MLS | `cargo test --locked --manifest-path otto-native/Cargo.toml mls::tests` | 18 通过、4 过滤；native-regression.log。是原有二人协议回归，绝非新群聊验收 |
| Server 类型 | `npm run typecheck --workspace=packages/server` | 通过；server-typecheck.log |
| Desktop 类型 | `npm run typecheck --workspace=packages/desktop` | 通过；desktop-typecheck.log |
| Server 构建 | `npm run build --workspace=packages/server` | 通过；server-build.log |
| Desktop 构建 | `npm run build --workspace=packages/desktop` | 通过；desktop-build.log |
| 本次相关 TS/TSX lint | `eslint <本次相关变更文件> --max-warnings 0` | 通过；lint.log、geometry-lint.log，精确文件清单见 lint-files.txt。未声称仓库全量 lint 通过 |
| Code map | `npm run code-map`；`npm run code-map:check` | 通过；code-map.log；重新生成无拓扑差异 |
| 包边界 | `npm run validate:boundaries` | 失败：既有 policyIntelligencePresentation.test.ts 深导入 server 源文件。本次新增契约已改用 otto-server 公共导出；boundaries.log |

服务端完整命令：

```sh
OTTO_CARPOOL_POSTGRES_TEST=1 ./node_modules/.bin/vitest run --config packages/server/vitest.config.ts packages/server/src/modules/park_carpool packages/server/src/enterprise/parkCarpoolRoutes.test.ts packages/server/src/enterprise/postgresBusinessRepository.test.ts packages/server/src/enterprise/clusteredServer.test.ts packages/server/src/modules/collaboration/mlsTransportRepository.test.ts packages/server/src/enterprise/parkEndpoints.test.ts
```

桌面命令（cwd=`/Users/yang/Desktop/otto-new/packages/desktop`，先构建 server 公共导出）：

```sh
../../node_modules/.bin/vitest run src/renderer/parkCarpoolContract.integration.test.ts src/renderer/parkCarpoolConversationBridge.test.ts src/renderer/components/ParkCarpoolDialog.test.tsx src/renderer/conversationDraftRecovery.test.ts src/renderer/components/InboxPage.test.tsx src/renderer/moduleWorkspace.test.ts src/renderer/moduleCatalog.test.ts src/renderer/moduleModal.test.ts src/main/enterprise-mls.test.ts src/main/enterprise-mls-private-messages.test.ts src/main/enterprise-mls-attachments.test.ts --maxWorkers=2
```

## 真实执行到什么边界

1. **真实 SQLite 与 PostgreSQL 17，同一业务契约**：临时数据库、真实迁移、字段加密、发布→同键重试→同键异内容拒绝→匹配→并发版本更新→重复停止→停用身份。另通过数据库 trigger 故意拒绝回执更新，验证意向与回执整笔回滚。数据库不是 mock。测试用本机私有临时 Unix socket PostgreSQL，结束后停止并清理本次临时目录；未连接生产。PG14 初次尝试不兼容已有迁移语法，改用已安装 PG17 后通过；未声称 PG14 支持。
2. **真实本地 HTTP→Service→SQLite**：启动 Node HTTP listener；匿名拒绝、伪造 accountId 不生效、发布、匹配、主动确认、重复停止、非所有者停止拒绝。认证适配用 `x-test-actor` 测试身份接缝，不是生产登录/设备握手实测，也不是 Electron IPC 端到端。
3. **真实对话输出→Service→加密 SQLite**：下午 3 点、浮动 20 分钟、确认发布写入；修改草稿后服务端停止，再确认旧草稿必须拒绝且不复活。
4. **真实 React 组件→Service→SQLite**：已有意向→停止并确认→立即重新发布；另一设备更新→刷新→“仍在寻找”→重新发布，不把旧字段配新版本写回。JSDOM 的 `window.otto` 直接连接真实 service，跳过 Electron IPC/网络/系统权限。
5. **合成地图边界**：以上测试均使用显式标识 synthetic/test 的可控 Provider，地点和坐标是测试数据；它验证真实业务和数据库，不验证供应商真实路线。没有把合成 Provider 接入生产作为替代接口。
6. **原有功能回归**：选定私聊、附件、MLS、Inbox、模块目录/布局/激活、园区及集群路由通过。没有执行所有原有业务真机流程、联邦 staging、全仓库测试或 Windows 真机。

## 独立复核及修复

独立只读 reviewer 对原 PRD 和当前实现复核，发现并促成修复：

- 对话草稿未绑定版本；结果刷新错误推进表单基准版本。
- 意向成功但回执失败可能造成不可恢复的幂等错误：改成同一数据库事务。
- 斜向路线稀疏/密集采样得到不同重合度：按邻近带裁切真实投影区间。
- SQLite 身份校验与 PostgreSQL 不一致；单个坏路线拖垮整批。
- 停止回执未推进表单版本；“仍在寻找”可能把另一设备的新版本和旧字段混合：改为权威记录整体 hydrate。
- 128 点等间隔采样漏掉短绕行：改形状简化；随后再发现直线折返会被距离简化抹掉，新增方向反转锚点及重复点处理。
- 官方模块迁移仅覆盖宏创官方组，验收矩阵已收窄范围。

关键红绿证据：red.log、review-red.log、sampling-red/green.log、reversal-red/green.log。短路段原有约 100% 高估回归改为约 3.9%；不宣称达到路网级道路识别精度。

## 按提示词逐项最终自查

| 问题 | 结论 |
|---|---|
| 从哪里进入，需要什么身份？ | 现有右侧 park-carpool/模块超市入口；企业 park_service 与园区绑定。原有布局逻辑有选定测试；真实安装/所有园区组迁移未完成验收 |
| 按钮能否完成真实操作，失败重试是否正确？ | 发布、修改、停止、确认有真实服务组件/数据库契约。路线、请求、邀请、群聊无完整实现入口 |
| 页面/对话/服务器/数据库/消息中心是否同一事实？ | 发布状态走共同 Service；消息中心尚无拼车事实接入，故整体不满足 |
| 关闭、移除、断网、重启后能否管理？ | 有退出提示与加密草稿代码；关闭/移除后消息中心管理入口缺失，进程重启/断网恢复真机未测 |
| 停止、过期、屏蔽、退出园区是否服务端生效？ | 停止持久 CAS；过期读时过滤；身份读写复核。屏蔽/持久身份失效处置/位置清理尚无实现 |
| 并发是否重复、超员、复活？ | 发布/停止版本和幂等事务有真实两数据库测试。尚无建组/容量业务，不能声称超员测试通过 |
| 路线百分比有解释，隐私如何？ | 有合成几何证据及近似说明；候选不回传私密端点标签。无安全区域/地图预览；相邻道路和立交不可区分 |
| 新/离开群成员可见性？ | 未实现。现有原生 18 项仍为企业二人协议测试，不能抵充多人/跨企业密钥与历史验收 |
| 服务器能力和功能一致？ | 保留原 park_carpool_v1 基础能力，未公布阶段二三；v1 不代表完整阶段一，正式上线能力语义仍需治理 |
| 所有 PRD 项有实现和执行证据？ | 否，逐项矩阵明确红项；整体不通过 |

## 外部条件与上线门禁

- 需要已经授权的地图测试凭据和测试账号，以及供应商对缓存/衍生计算的许可结论。当前地图 Provider 的已有搜索/规划接入及本次失败行为修复有代码，但真实供应商链路未实测；逆编码/预览仍是内部未完成项。
- 需要产品确认组阈值、绕行上限、位置保留期限；安全/运营确认举报处理责任人与身份失效处置策略。缺确认不妨碍继续开发相关契约，但当前契约/功能尚未全部实现。
- macOS/Windows 真机定位允许、拒绝、系统设置变更和桌面重启仍未测；定位代码本身也未完整实现，不能仅标为“待真机”。
- 跨企业两人及多人 E2EE、入组前/退组后历史隔离尚需内部协议实现，然后用授权测试身份和多个真实设备验证。
- 未执行生产部署、购买、推送、外部联系或真实用户消息。源码体积、既有边界违规以及本表全部功能缺口解决前，不具备完整 PRD 上线条件。

最终 reviewer 只读复跑确认：`[0,100,50,200]` 与含重复点的 `[0,100,100,50,200]` 简化后均保留必要四个点，简化前后与直行候选的重合度均约 80%；PRD-052/321 的范围修订也已核对。此结论仅覆盖折返修复及报告，不改变整体不通过的结论。
