# 1.9.15 Blue Heron 功能整合复核（2026-09-09）

本记录是对新整合分支的增量审计，不替代此前候选审计、签名包验收或真实生产验收。只读检查对象是 integration `e8995754fa1f9f341190ee165d07ebc25993e161`；随后读到 `3a622e6e` 的相关业务代码未改变。未连接或修改生产，也未触发发布。

## 结论与发布边界

- 确认一个 P1 配置交付缺口：原部署解析白名单和安装器只认识地图 Key/重合度，无法接受三个通信开关及试点/保留期限等新配置。候选修复 `65e1f8c2` 仅修改新包 common/install/env 模板/说明及独立回归，未修改旧包、upgrade 或固定网关。必须将它合入最终源码和重新构建的签名包。
- 拼车代码合入不等于所有通信阶段已经启用。三个开关全部默认 false；当前准备只能称 requests 单园区试点，不能称 invitations/groups 生产端到端已验收。真实园区 ID、有效地图 Key、客户端账号/设备审批、MLS 能力及相关许可仍须实际验收。
- 本次范围内未发现同事功能被冲突整块丢弃，或原候选 Agent/频道安全实现被覆盖。这个结论基于内容差异、实际入口和权限/生命周期调用链，不是依据 commit 祖先关系推断所有功能正确。
- 没有重跑全部产品测试。旧交付文档中的测试、截图及交互记录是历史本地证据，不是本次生产结果；它们明确列出真实地图、Windows 定位、完整多用户/多节点旅程等证据缺口。

## 内容比对方法与边界

同事分支 `e7cf417da63b331d96099a0eb5d634f9fc2b2654` 从共同基线 `93dcf8ea2dd0e9582589351a6e126ecd24b33b86` 改动 824 个路径（含文档/证据/资源，不是 824 个业务模块）。其中 783 个在 e899 保持相同 Git blob，41 个因与既有候选融合或后续修复而不同，未发现这 824 个路径有删除。合并 `071fa0b6` 的双亲为原候选 `49d02bcc` 和同事 e7cf；后续政策/发布/地图/类型/媒体修复另行合入。

`git diff 49d02bcc e8995754 -- packages/core packages/server/src/server.ts packages/server/src/turnConstraints.ts packages/server/src/modules/integration_adapters packages/server/src/feishu` 为空。即原候选 Core、主 Agent Server/约束以及官方 QR/飞书/频道安全路径在本次整合后逐字节保留。政策有界后台通过后续候选合并加入，不是回退同事较旧的政策实现。

部分历史 promisor blob（例如 ac1a89c3…）不能从远端取回，不能声称已完整重新执行三方自动合并。现有完整双亲/最终 tree、37 个 commit 标题/范围及产生的 remerge conflict 记录仍能独立用于最终内容检查。

## 同事 37 个提交的功能归属

| 功能/提交 | 当前实现和可达证据 | 复核结论 |
| --- | --- | --- |
| 三阶段拼车与独立启动：7c4d016f、1fca182e、aac4b677 | `park_carpool/{parkCarpoolService,parkCarpoolWorkflow,parkCarpoolTransport,parkCarpoolRuntime}.ts`；Desktop `park-carpool-chat.ts`、`park-carpool-startup.ts`；main 的 createParkCarpoolChat / ParkCarpoolStartup / IPC handlers | 保留请求、邀请、群组、密文会话和历史管理；首次尝试超时/取消不阻塞原企业消息。服务维护已接入统一 registry，集群持有/续租/释放逻辑保留。 |
| 无地图时入口及诊断：f7de89e6、717201c7 | `moduleCatalog.ts:175`；`ParkServicesPlugin.tsx`；`ParkCarpoolDialog.tsx`；service get 状态的 mapConfigured/canPublish/reason | 入口可诊断，不把网络读取失败伪装成缺 Key，也不在未配置地图时生成虚构路线。 |
| 原内置测试 Key：0c29997a | `amapParkCarpoolProvider.ts:78` 的 resolveAmapWebServiceKey 只读服务器环境 | 有意不保留内置测试 Key；这是密钥边界修复而非漏合。客户端只接地点/路线或静态图数据，不获得 Web Service Key。 |
| 拼车界面/检索迭代：b3b0dfbe、fe7acc0c、d6ba9409、9c4a4973、a6cdd1f5、219c66a9、c7d91e21、766350ba、99029fb4、09925ed4、0539b16a、2ca999ab | `ParkCarpoolDialog`、`CarpoolPointPicker`、`CarpoolRequestCenter`、`CarpoolRequestComposer`、`CarpoolRouteComparison`；provider suggest 的合并请求/64 项 POI 缓存 | 表单优先、独立点位选择、autocomplete、发布与消息/管理分离仍在。766350ba 的模拟匹配后来由 99029fb4 明确移除，不应复活旧示例界面来声称保留功能。 |
| 市场业务、加密附件、验收：1b3a05bf、cecf75a1、a13d3a96 | `park_services/flea_market/*`、`collaboration/parkContact*`；Desktop `park-market*.ts`；`enterpriseRouteDispatcher.ts`、clustered server 的市场 handler | SQLite/Postgres 配置、商品生命周期、联系人/MLS/附件、审计和维护原样保留；不是仅静态 UI。 |
| 市场入口和视图：99266006、6cd34603、ae114040、477a8dee、a197bdf9、a67a395e、7a54a180 | `moduleCatalog.ts:169`、`ParkMarketDialog.tsx:180`、`MarketContactCenter`、App 的市场 modal/records/deep-link 渲染 | 买卖方/记录/询问路径保留。自动 demo 仅 local/loopback 且初始 market 视图；远程企业默认真实数据入口。显式 demo 不等于真实服务器商品。 |
| 星链/行业/供需：0c075de0、97478075、9804ee47、e7cf417d | `moduleCatalog.ts:163`、`EnterpriseStarMapView`、`starMap/{EnterpriseGraphCanvas,EnterpriseList,graphModel,layoutCache}`；`generalizedParkRoutes.ts:98` 和 `clusteredBusinessRoutes.ts:1541` | 行业标签、公开企业资料、供需图/示例、初始视口/标签整理保留。真实 route 经账号、园区服务权限，示例数据不冒充真实企业资料。 |
| 模块/工作区整理：b6eb8fc4、444d13ad、30ff4d2a、3cab0ed9 | `moduleWorkspace`、`moduleModal`、`ModuleWorkspace`、`moduleGroupCatalog`、WorkspaceDialogs 的 DialogFrame | 最后添加模块 tile、三行滚动、稳定工单轮询和窗口状态保留；portal/Escape/focus 以及旧 Skill 版本/知识能力也存在。 |
| 业务消息隔离：d673e153 | `InboxPage.tsx` 的 conversations/market/carpool 分类，App 连接市场及拼车通知/打开动作 | 原私信、工单、跨服联系人未被替换；政策助手作为旧候选增量保留，独立业务分类首次打开才挂载。 |

## 11 个原冲突文件

| 文件 | 最终融合证据 |
| --- | --- |
| `package-lock.json` | 新 HEIC/sharp 及其平台依赖与既有官方 QR SDK 同时保留；后续 npm10 锁一致性修复另有提交。源码 sidecar 和平台 native 包验收不因有 lock 就自动成立。 |
| `packages/desktop/src/main/index.ts` | carpool chat/startup、市场 MLS/附件/IPC、star-map IPC 都存在；原 endpoint 迁移/身份清理、渠道、Workable/招聘等候选入口没有被替换。与 e7cf 的差异未删除 carpool/market 业务 handler。 |
| `packages/desktop/src/renderer/App.tsx` | 模块 modal、市场记录/deep-link、拼车历史管理与删除通知同时存在；政策 inbox/dialog、招聘 workbench 和候选 Skill/知识交互仍接入。 |
| `packages/desktop/src/renderer/components/InboxPage.tsx` | 保留同事业务分类，新增原候选 policy conversation；私信/工单/联邦原会话渲染仍在。 |
| `packages/desktop/src/renderer/components/WorkspaceDialogs.test.tsx` | 保留模块窗口测试并纳入候选知识/Skill 行为；不能用测试合并替代运行入口检查。 |
| `packages/desktop/src/renderer/components/WorkspaceDialogs.tsx` | DialogFrame portal、Escape、Tab/focus 恢复及 icon/subtitle；知识证据/Skill 功能说明、版本/回滚面板共存。 |
| `packages/server/package.json` | 保留 server 自身版本 0.1.0；`heic-decode=2.1.0`、`sharp=0.35.4`、`@wecom/aibot-node-sdk=1.0.7`、`dingtalk-stream=2.1.7-beta.1`；招聘 public subpath 和 dist/NOTICE 包文件规则在。 |
| `packages/server/src/enterprise/clusteredServer.ts` | 市场、拼车与政策/招聘 route/capability/worker 均接入；两个 registry + readiness + HTTP 合并排空，成功后才关闭 infrastructure。 |
| `packages/server/src/enterprise/server.ts` | SQLite composition 同时启动政策/招聘/市场/拼车；canaryMode 不启动这些业务后台；关闭等待 registry、HTTP 与市场 readiness，失败不假称排空完成。 |
| `packages/server/src/index.ts` | 保留 carpool 公共组合 export，新增/保留招聘、官方 QR/runtime、飞书 device registration、policyApplicationStatus；没有通过 Desktop 深导入实现。 |
| `packages/server/src/modules/authorization/enterpriseRoutePolicy.test.ts` | 对应 production policy 仍把 carpool/market、star-map 列为 member routes；招聘例外只覆盖自有凭据撤权而非候选读取。 |

## 权限、阶段开关与生命周期

生产调用链为 moduleCatalog/ModuleMarketplace → App modal → preload IPC → main EnterpriseClient → signed enterprise HTTP。`enterpriseRoutePolicy.ts:108` 将拼车/市场路由归为 member；`commercialRoutePolicy.ts` 将 `/enterprise/park-*` 和 star-map 归入园区服务。市场历史、退出/下架、消息恢复等窄路由有明确商业许可例外，但服务端继续校验账号所有权、会话/设备身份；恢复发布仍重验 entitlement。不能用 UI 开关作为授权。

`parkCarpoolService.ts:378` 的 canPublish 同时要求 requests、pilot 和已配置地图；service 新发布/匹配、workflow 请求/邀请/群组写入及 transport MLS 写入各自重新检查阶段/园区。`ParkCarpoolStartup` 只在已批准设备作用域内启动；即使 communication capability 关闭，只要历史 conversations 存在仍可恢复读取。保留停止/退出/历史正是关闭阶段时不可删除数据的原因。

集群 `drainClusteredEnterpriseResources` 等待 `marketTasks`、`recruitmentMaintenanceRegistry`、市场 initialize 和 HTTP；失败/超时不会执行 infrastructure.close。SQLite 的 gracefulClose 同样等待市场 readiness 和 registry。`parkCarpoolRuntime` 每 60 秒调度、单飞；Redis lease 120 秒、40 秒续租，stop 会 abort/取消后续调度并等待在途续租再释放。它仍是协作取消，不是已提交数据库操作的跨进程硬 fencing；不能把本地 shutdown 测试解释为生产全链路证明。

## 准确的生产配置与待验收项

完整字段、范围、旧版本回滚顺序已加入 [部署说明](../deployment/enterprise-oneclick/README.zh-CN.md)。首期值应为：

```text
OTTO_PARK_CARPOOL_REQUESTS_ENABLED=true
OTTO_PARK_CARPOOL_INVITATIONS_ENABLED=false
OTTO_PARK_CARPOOL_GROUPS_ENABLED=false
OTTO_PARK_CARPOOL_PILOT_PARK_IDS=<已经核实的真实单园区ID>
OTTO_AMAP_WEB_SERVICE_KEY=<管理员在服务器秘密配置中提供>
```

上述占位符不是可直接执行的生产配置。Key 只能进入服务器 0600 配置，不能入仓库、桌面包、普通日志或公共验收材料。pilot 省略意味着所有合资格园区，不可将省略误解为默认限制试点。服务启动时冻结这些配置，改动后需服务级重启，禁止依赖整机重启救援。

跳蚤市场缺省 enabled=true，不需要添加不存在的总开关；仍须 active account/org、园区绑定、园区服务授权，及数据库、字段加密、对象存储、图像处理、维护 worker readiness。正式远端入口不可拿本地 demo 或 `OTTO_MARKET_LOCAL_ACCEPTANCE` 代替验收。

建议最终 exact artifact 验收至少覆盖：未配置/暂停/跨试点拒绝新发布；已配置真实地图的双账号请求；关闭后历史仍可读、能退出且新写受限；启用 invitations/groups 前的真实两人/三人 MLS 接受、撤销、退出、重登恢复；市场真实上传/解码/询问/下架与无权账号拒绝；star-map 仅展示合资格公开资料；optional carpool 初始化失败不影响原企业消息。应保留源码/产物身份与脱敏结果，不能回填历史报告冒充本次结果。

## 本次配置修复验证

新增配置测试先出现 3 个确定失败（白名单拒绝 flags、缺输出、清单缺键），修复后 4/4 通过；与旧 installer suite 合计 49 通过、4 个既有平台限定测试在 Windows 跳过。使用真实 Bash 执行解析/安装输出、未知键拒绝、值不执行、默认关闭/未设 pilot、显式空值不悄悄改为默认，以及实际升级脚本内嵌 env 转换。直接载入整合分支 `readCarpoolConfig` 核对了全部 15 个参数与 3 个非法输入拒绝。ESLint、diff-check、code-map:check 和 common/install Bash 语法通过。本机 doctor 唯一失败为 npm 命令 PATH 检测；Node/vitest 直接调用确实执行，未宣称 doctor 全通过。
