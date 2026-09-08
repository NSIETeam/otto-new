> 2026-09-08 复审四项已修复，最新源码在 `/Users/yang/Desktop/otto-carpool-fixed-91bc4e`，最新结果见 [复审修复验收](review-repair-report.md)。下文原交付日志保留为历史证据；默认开关、初始化和旧组迁移以修复报告为准。

# 拼车最终自查与验收报告

2026-09-08。三个阶段的服务端、数据库、桌面入口和 Native 加密链路已实现，并在本地真实数据库及组件/Electron 流程中验证。**尚不具备“所有真实环境验收全部通过”的结论**：真实地图、正式身份部署、系统定位、Windows 和生产规模/回滚门禁仍未实测。逐条状态见 [367 条 PRD + 17 条补充验收矩阵](acceptance-matrix.md)。

交付分支 `codex/blue-heron-7f3a9c`，基线 `93dcf8ea`；只做本地 Git 提交，不推送或合并 internal。最终源码目录 `/Users/yang/Desktop/otto-carpool-verified-7f3a9c`，独立于其他任务的跳蚤市场改动。测试执行时工作目录 `/tmp/otto-carpool-validation-7f3a9c`，交付后的固定工作目录见实施记录。日志仅清理行尾空白与末尾空行以通过 Git whitespace 检查，测试内容与结果未改变。`final-*` 为最终证据；其他日志为历史检查/失败证据，不应混作当前通过结果。

## 三个阶段及本次修复

- 阶段一：当日发布/修改/停止/确认、管理员集合点、地点搜索和选点、个人分页匹配与脱敏路线、请求/接受聊天、消息中心、屏蔽/举报、通知/已读、保留与用户删除、统一页面/对话契约。
- 阶段二：明确方式/司机/容量的邀请、两人同行组、请求失效/撤回/冷却、独立群会话、停止新匹配保留组与退出停止分流。
- 阶段三：每候选独立组匹配、真实路线绕行契约、入组/邀人、最后名额及单用户单组事务约束、角色转交、退出/关闭/历史、成员变化的真实 MLS 密钥隔离。

纠正重合度高估、日期跨日、中文门牌泄露、对话时间/窗口/地点误选、规划期间旧状态复活、迁园区错误清理及回执竞态。自查补齐组内路线、两人历史入口、聊天发送者标签、同组屏蔽和单消息举报、迁移意向统计比例、批量组召回、通用园区布局一次性迁移。最后完整 UI 回归发现发送成功的结果卡未显示等待状态，已对个人和组结果同步更新已成功的服务器事实，保留排序并重跑通过。

## 实际执行的检查

以下命令相对上述独立副本根目录；标注“desktop cwd”的在 `packages/desktop` 执行。计数有交叉，不能相加声称独立用例总数。

| 检查与命令 | 结果与证据 |
|---|---|
| `npm run doctor` | 独立源码副本通过，源体积 38.83 MB；[日志](evidence/final-doctor.log)。原工作目录含用户既有 native/资料时超 50 MB 的失败仍保留，没有删除这些文件或提高阈值 |
| `git diff --check` | 通过，提交前再次检查 |
| `OTTO_CARPOOL_POSTGRES_TEST=1 npx vitest run --config packages/server/vitest.config.ts packages/server/src/modules/park_carpool packages/server/src/enterprise/parkCarpoolRoutes.test.ts` | 17 文件 / 93 通过；[服务端](evidence/final-server-suite.log)，真实 SQLite 和临时 PostgreSQL 17、HTTP、Native、两库 205 候选与 30 组跨批场景 |
| desktop cwd：`npx vitest run src/renderer/components/Carpool src/renderer/components/ParkCarpoolDialog.test.tsx src/renderer/parkCarpool src/main/park-carpool src/main/enterprise-e2ee.test.ts` | 8 文件 / 33 通过；[桌面](evidence/final-desktop-focused.log)，包含完整组件旅程、实际加密与页面/对话服务契约 |
| desktop cwd：`npx vitest run src/renderer/moduleWorkspace.test.ts` | 22 通过；[布局](evidence/final-layout.log)，包含先红后绿的通用布局迁移、能力恢复及移除后不重加 |
| `node packages/desktop/scripts/carpool-acceptance/electron-smoke.mjs` | 真实 Electron 窗口通过；[日志](evidence/final-electron.log)、[截图](evidence/electron-carpool-chat.png)。设备签名 HTTP + SQLite + Native + macOS safeStorage；地图为显式 fixture，账号为隔离测试身份 |
| 桌面原功能回归（下方完整命令） | 11 文件 / 179 通过；[日志](evidence/final-desktop-regression.log) |
| 服务端原功能回归（下方完整命令） | 6 文件 / 60 通过；[日志](evidence/final-server-regression.log) |
| `cargo test --manifest-path otto-native/Cargo.toml --target-dir /Users/yang/Desktop/otto-new-carpool/otto-native/target mls -- --nocapture` | 从独立副本编译测试，27 通过；[Native](evidence/final-native-tests.log)，复用目标构建缓存，未复用服务实现源码 |
| `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/otto-native-runtime.test.js` | 11 通过；[探测回归](evidence/final-native-probe-tests.log)，拒绝仅支持旧 ping 的二进制 |
| `node scripts/otto-native-runtime.mjs build --target darwin-arm64 --probe` | 开发目录实际固定 Rust 1.97.1 构建/探测通过；[构建](evidence/final-native-build-probe.log)。未生成正式安装包 |
| `npm run typecheck --workspace=packages/server`；`npm run typecheck --workspace=packages/desktop` | 通过；[server](evidence/final-server-types.log)、[desktop](evidence/final-desktop-types.log) |
| 对全部本次 TS/TSX/JS/MJS 源码和测试执行 `npx eslint --no-ignore <changed-files> --max-warnings 0` | 通过；[lint](evidence/final-lint.log)。首次发现验收脚本被默认忽略，随后明确纳入并修复 Node 全局导入，没有降低规则 |
| `npm run build --workspace=otto-native`、`packages/core`、`packages/workflow`、`packages/server`、`packages/desktop` | 通过；[SDK](evidence/final-native-sdk.log)、[core](evidence/final-core-build.log)、[workflow](evidence/final-workflow-build.log)、[server](evidence/final-server-build.log)、[desktop](evidence/final-desktop-build.log) |
| `npm run code-map`；`npm run code-map:check` | 已生成/核对通过，最终内容无需变化；[日志](evidence/final-code-map.log) |
| `npm run validate:boundaries` | **失败**：既有 `policyIntelligencePresentation.test.ts` 深层导入 server policyDomain；[日志](evidence/final-boundaries.log)。不是拼车代码，未删除测试或降低门禁。没有宣称全仓库全绿 |

桌面原功能回归（desktop cwd）：
```
npx vitest run src/renderer/moduleWorkspace.test.ts src/renderer/moduleModal.test.ts src/renderer/components/InboxPage.test.tsx src/main/enterprise-client.test.ts src/main/enterprise-e2ee.test.ts src/main/enterprise-mls.test.ts src/main/enterprise-mls-attachments.test.ts src/main/enterprise-mls-private-messages.test.ts src/main/federation-atoa-protocol.test.ts src/main/federation-atoa-tasks.test.ts src/renderer/federationAtoaProtocol.test.ts
```

服务端原功能回归（根目录）：
```
npx vitest run --config packages/server/vitest.config.ts packages/server/src/modules/collaboration/mlsTransportRepository.test.ts packages/server/src/modules/federation_gateway/federationRoutes.test.ts packages/server/src/modules/federation_gateway/federationComposition.test.ts packages/server/src/modules/data_platform/attachmentStorageService.test.ts packages/server/src/modules/data_platform/postgresAttachmentMetadataRepository.test.ts packages/server/src/enterprise/clusteredAttachmentMaintenance.test.ts
```

## 实际用户旅程与边界

React 完整流程实际点击：地点多候选选择→填写当日时间/方式→发布→结果→路线图→发消息请求→另一账号接受→实际 Native 私聊收发→结构化邀请→接受建两人组→查看本组路线/群聊→关闭多人能力仍保留两人历史→第三人发布并申请入组→协调人同意→新成员只看到加入后消息、两名发送者可辨别→成员消息举报→退组与历史限制。测试使用真实服务和加密 SQLite，未把 mock 参数校验当完整功能。地图结果是显式测试 Provider，因此不证明真实高德准确率。

Electron 脚本在真实窗口中发布、预览、发送请求、进入聊天和发送消息；接收方接受及解密由测试主进程驱动，**不是两台实体设备各自手工点击**。HTTP 使用真实设备签名，登录身份由隔离测试 bearer 注入；没有宣称经过正式登录服务或在完整 Otto 产品壳手测全部入口。

## 十项独立自查

1. **入口/身份**：唯一右栏模块和我的消息；要求获授权的企业园区成员及后端能力，通用已有园区组一次迁移。正式账号/许可完整 App 登录待实测。
2. **按钮/失败重试**：上述完整路径通过，Provider 失败保留表单，发布成功回执与刷新错误区分，请求成功立即显示等待。系统定位拒绝/恢复尚无真机证据。
3. **同一事实**：页面、对话、HTTP、SQLite/PG 与消息中心共同服务契约；真实跨层测试通过，没有前端独立成组状态机。
4. **关闭/移除/断网/重启**：服务及加密状态持久化、丢响应重试/重连恢复已测；入口移除保留业务由代码和布局回归核对，完整 App 拖拽、退出再登录恢复草稿尚未手工逐项验收。
5. **失效执行**：停止、过期、屏蔽、迁园区、停用与删除在服务器维护/事务中验证，两库合同通过。
6. **并发**：版本/CAS、幂等、最后名额、单用户单组、角色转交容量、旧请求失效通过真实数据库测试；多节点故障切换压力未测。
7. **路线/隐私**：区间公式与长短 2% 样例、方向/交叉/采样上界有证据；端点删除/粗化。道路层级几何近似与许可未验证，不能承诺真实路网精度。
8. **历史权限**：新成员/离开成员受服务授权和 Native 密钥限制，真实密文解密隔离通过；长期离线、多设备极端配额与 Windows 密钥链待实测。
9. **能力声明**：两库均接通；请求/MLS→邀请→多人依赖，关闭多人保留已授权历史。生产配置仍需部署方显式门禁，不因代码默认 true 视作批准。
10. **逐项证据**：矩阵保留全部 PRD 条目，区分契约通过、组件通过、代码核对、外部待验；完整产品兼容/系统能力没有全标绿。独立只读 reviewer 发现的布局和组结果等待状态已修复并回归。

## 未实测、外部条件与工程限制

| 项目 | 当前结论 / 完成所需条件 |
|---|---|
| 高德真实服务、地图数据缓存/衍生/展示许可 | Provider 代码与失败契约完成，真实环境未验；需授权测试 key、供应商许可结论及代表园区道路数据 |
| 正式企业登录/许可/设备审批、完整产品壳 | 隔离身份跨层流程通过，正式全链路未测；需授权测试部署和账号 |
| 定位与多平台 | macOS 用途说明及受信任主 frame grant 已实现；macOS/Windows 允许、拒绝、设置恢复和 Windows 安全存储/安装包未实测，需真机 |
| 全部旧模块激活、panel/page、拖拽和重新添加 | 有布局/统一入口/Inbox 回归；公告、调查、工单、星链图等完整壳逐项手工激活未执行 |
| 生产 SQLCipher / PostgreSQL 多节点、备份回滚 | 本地字段加密 SQLite、PG17通过；生产加密运行时迁移、备份恢复、多节点故障及回滚演练未执行 |
| 性能、真实路线质量及成本 | 205 候选和跨 25 批边界的 30 组验证正确性；园区授权聚合仍 O(园区状态)，地图规划成本和高峰延迟需真实规模测试，未承诺容量 |
| 保留/阈值/举报责任 | 集中工程默认及管理员处理已实现；需运营/安全明确批准期限、阈值及人工处理负责人 |
| 消息设备极限 | Native 明确限制设备/KeyPackage/代次/缓存量并失败关闭；长期离线、超限高频用户尚未压力验收 |
| 完全退出 App 的 OS 通知 | 本次实现不支持；站内事实可重登读取。不是后台推送服务，不能声称 App 退出仍弹本机通知 |

未执行全仓所有测试、正式安装包制作、生产部署或推送。既有边界门禁失败仍需所属模块修复；上述真机/真实部署验收必须另行完成，不以本地测试数量替代。

最终独立只读复核：证据链接均存在，日志计数一致；布局和组结果等待状态修复已复核，未发现新增阻断项。
