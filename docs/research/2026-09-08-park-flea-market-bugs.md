# 园区跳蚤市场缺陷台账（开发检查点）

本任务尚未完整交付。下面区分实际复现的缺陷、已修复项和未实现需求；不将缺少功能伪装为环境故障。

| ID | 严重性 | 前提/复现步骤 | 预期 / 实际 | 根因 | 修复位置 | 复测证据/状态 |
|---|---|---|---|---|---|---|
| FM-001 | P1 | 并行拼车开发新增迁移 15 后，运行 fleaMarketMigration.test.ts | 编号唯一连续 / 市场与拼车都为 15 | 共享迁移文件并发编辑 | enterprise/postgresMigrations.ts：市场改为 16，保留拼车 15 | migration-red.log（1 failed）→ migration-green.log（1 passed），真实 PG 完整迁移 task3-full-migrations.log；已修复 |
| FM-002 | P1 | 已成功发布后，在重试外层身份读取之后停用账号，再重放同 requestId | 停用账号拒绝 / 返回旧幂等结果 | 只在进入事务前检查账号，命中 receipt 时跳过内层身份复核 | fleaMarketUnitOfWork.ts authorize 在查询 receipt 前执行；Service 注入实际身份复核 | replay-auth-red.log（1 failed/1 passed）→ replay-auth-green.log（2 passed）；已修复 |
| FM-003 | P2 | 对新目录运行 ESLint | 0 error / 4 error | 参数属性使用不符合仓库规则的 public；control regex 违反 lint | fleaMarketTypes.ts、fleaMarketValidation.ts | market-eslint.log → market-eslint-fixed.log；已修复，业务校验继续通过 |
| FM-004 | P2 | 提交商品举报后结案，读取 evidence 引用的 expires_at | 结案后 180 天 / NULL | 结案事务未设置证据引用保留期限 | fleaMarketModeration.ts、Attachments.cleanup、Jobs 报告内容清理 | evidence-retention-red.log → evidence-retention-green.log（4 passed）；结案期限修复通过。法律保全及完整证据清理端到端仍待实现/验证 |

## 后续复现并修复

| ID | 前提与实际问题 | 修复位置 | 证据与状态 |
|---|---|---|---|
| FM-005 | 治理移除图片仍可借所有权重新发布 | fleaMarketService.validateImages：要求当前有效引用授权 | 双数据库图片 HTTP 测试通过 |
| FM-006 | 被撤销管理员重放旧请求返回成功 | UnitOfWork 在幂等回执前检查当前园区角色；限制原因加密 | 双数据库治理与显式角色测试通过 |
| FM-007 | 正式企业登录访问市场被成员路由鉴权拒绝 | enterpriseRoutePolicy 注册精确市场路径 | verified-real-flows.log，真实登录 HTTP 全流程通过 |
| FM-008 | 加密关键词无结果查询 P95 达数十秒 | HMAC 搜索索引与加密独立园区密钥、精确匹配复核 | capacity-before-index.json → capacity.json；本地查询指标通过 |
| FM-009 | 同时发送两条消息并超时，待重试密文互相覆盖 | park-market-messaging.ts 保存前重新读取并合并当前记录 | verified-send-race-red.log → verified-desktop-tests.log；通过 |
| FM-010 | 关联商品只来自已加载消息，较早咨询遗漏 | contacts.associated 独立分页与 MarketAssociatedItems 原消息定位 | verified-associated-red.log → verified-associated-green.log；UI green；通过 |
| FM-011 | 超量选图整批拒绝，未保留剩余可用名额 | selectMarketImages；按顺序接收名额内文件、列出拒绝文件 | verified-image-selection-red.log → green.log；通过 |
| FM-012 | 同账号 ID 切换服务器/组织后旧私有表单仍在 | ParkMarketDialog 子树按服务器/组织/账号重新挂载 | verified-scope-ui-red.log → green.log；通过 |
| FM-013 | 本机 MLS 状态丢失导致会话无法收发 | 显式带代际 CAS 的恢复；旧消息逐条不可解密提示 | verified-real-flows.log；真实 native SQLite/PG 通过 |

## 本轮新增修复（13:38）

- FM-014：原生 MLS 会话可被旧信封降级；服务端要求 production requiresMls 或已存在 native 会话时拒绝信封。verified-downgrade-green.log 通过。
- FM-015：旧请求超过 200 条不可达、已加载旧通知跨设备状态不刷新；服务与 UI 均补游标分页及完整已加载页刷新，SQLite/PG 220 条测试通过。
- FM-016：过期 key-package 被客户端重新发布；仅发布 native 标记 publishable 的密钥，测试通过。
- FM-017：登录未续租全部草稿图片；独立续租各草稿，失败标记保留文字，并在写回前复核最新草稿和账号范围，测试通过。
- FM-018：图片上传缺实际进度/单图取消；HTTP 流、主进程作用域取消管理、IPC 与逐图 UI 已接通，真实 HTTP 取消及组件测试通过。
- FM-019：草稿页内切换绕过保存确认、已保存仍强制确认；统一退出流程及持久保存比较已修复。
- FM-020：列表返回丢分页/滚动、分页重复；按筛选保存列表和位置并按 ID 去重，RED → GREEN。
- FM-021：失效草稿图仍能点击正式发布；图片读取结果驱动拦截，重试或删除后恢复，RED → GREEN。

## 当前仍未完成或未验证

- 治理/状态操作同界面超时重试已复用标识并通过组件测试；跨重启完整确认流程、两账号 Electron 组件＋真实 HTTP 闭环和首次错误焦点已通过；完整安装包、键盘全矩阵和断网矩阵仍需验收。
- 法律保全和经确认的聊天/最小记录/备份保留策略衔接。没有擅自新增永久保留或删除聊天策略。
- S3 真服务验收、100 个独立原生 MLS 客户端及所有状态接口性能、网络限速首批可操作时间。
- Windows 安装包与 native MLS/HEIC 验收。

关于联邦/附件：同部署园区账号不能登记为远端联邦联系人，现有联邦仓库对此明确拒绝。同企业私聊复用并保留既有附件，已建立市场会话复用已实现；新的市场跨企业会话仅开放已验证的文字能力。此处不再把“不伪造联邦联系人”列为漏做功能，具体依据见技术决策。

## 当前环境和外部上线条件

- 当前指定分支 doctor 通过。边界检查仍有既有政策模块测试深层导入服务端的 1 项失败，保留原代码。
- Windows 实机与安装包 HEIC/GPS/旋转、native MLS 验收尚未进行。
- 需要具体运营规则、责任人和经确认的保留/备份策略；MLS 生产 release policy 仍关闭，未绕过发布门禁。
- 市场代码保存为本地检查点，已有拼车提交保留。未推送 GitHub。

- FM-022：外层模块开关阻断关联历史/历史图片读取；精确 GET 路由放行到既有授权检查，RED → GREEN，42 项通过。
- FM-023：治理/状态操作超时生成新请求 ID；账号视图内复用同参数回执并合并双击，2 项逻辑及治理组件通过。

- FM-024：表单提交失败没有定位首个错误；增加焦点与所有必填控件的 aria-invalid，keyboard-focus RED → GREEN。
- 验证补充：两账号 Electron 真实服务链路通过；100 调用聊天专项四种组合通过，客户端串行加密与每账号限流的实验范围限制已说明。
