# PRD 非列表结构追踪

367 条无序列表已在矩阵逐项保留；本表额外保留全文的有序步骤及现状表，防止以条目数量代替全文完整性。以下用户操作均需连同其相邻矩阵条目验收，未用组件测试替代正常 App 完整操作。

| 行号 | 有序步骤原文 | 对应证据及剩余项 |
|---|---|---|
| L359 | 1. 用户在“园区服务”功能组点击“拼车助手”。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L360 | 2. 用户主动定位或手动选择出发地。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L361 | 3. 用户搜索并选择目的地。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L362 | 4. 用户填写期望出发时间和可接受的时间范围。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L363 | 5. 用户选择至少一种出行选择，可以多选。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L364 | 6. 用户点击“发布并查找同路伙伴”。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L365 | 7. 系统创建或更新该用户当日唯一有效同行意向。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L366 | 8. 系统筛选同园区、同日期、时间接近、出行选择兼容且方向一致的有效意向。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L367 | 9. 系统逐一计算路线重合度，阶段一返回多个个人结果；阶段三开启后再纳入同行组结果。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L368 | 10. 结果按照与当前用户的路线重合度从高到低展示。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L372 | 1. 用户在个人卡片上点击“邀请同行”。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L373 | 2. 若双方只有一种兼容方案，系统直接带入；若存在多种方案，发起方在轻量确认层选择“我开车”“对方开车”或“一起叫车”中的可用项。若发起方将作为司机且尚未设置容量，发送前询问本次最多可同行乘客数。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L374 | 3. 对方在“请求”中收到标记为“同行邀请”的结构化卡片；私家车同行还需显示本次由谁开车。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L375 | 4. 发起方看到“已邀请，等待确认”，不能重复发送邀请。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L376 | 5. 对方点击“接受同行”。若其为私家车司机且尚未设置容量，系统询问“本次最多还能同行几人？ [1 人] [2 人] [3 人]”。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L377 | 6. 系统将双方从个人候选状态转为“2 人同行组”，并固定该组的 `travelMode`。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L378 | 7. 双方个人卡片从公共结果中消失，替换为一个 2 人同行组卡片。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L379 | 8. 系统创建同行群聊，双方可以协商集合地点和时间。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L383 | 1. 用户在结果页看到“3 人同行”卡片。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L384 | 2. 用户查看与该组的路线对比、成员脱敏信息和该组已确定的同行方式；若为私家车同行，同时展示司机身份。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L385 | 3. 用户点击“加入同行”。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L386 | 4. 私家车司机或一起叫车协调人收到结构化入组申请。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L387 | 5. 司机或协调人同意后，申请者成为正式成员；服务端需再次校验剩余容量和并发版本。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L388 | 6. 系统重新计算该组对其他外部候选人的组匹配度。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L389 | 7. 新成员进入同行群聊，但不能查看加入前的历史消息。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L393 | 1. 用户在个人卡片点击“发消息”。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L394 | 2. 用户发送第一条文字消息。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L395 | 3. 对方在“消息请求”中查看发送者身份、匹配摘要和消息预览。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L396 | 4. 对方选择接受、忽略或屏蔽。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L397 | 5. 接受后双方进入正常一对一会话。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L398 | 6. 接受聊天不等于接受同行；任一方仍需发送并接受同行邀请才能组成同行组。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L402 | 1. 用户在结果页点击“停止寻找”。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L403 | 2. 未加入同行组时，系统轻量确认后停止当前意向。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L404 | 3. 已加入同行组时，系统展示三个明确选择：“停止接受新匹配，保留当前同行组”“退出同行组并停止寻找”“取消”。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L405 | 4. 用户确认后，当前同行意向不再出现在新的匹配结果中；如选择保留小组，已有组成员和群聊不受影响。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L406 | 5. 尚未处理的邀请和入组申请按用户的选择失效或保留，不可用一个含糊的“停止寻找”同时触发用户未预期的退组。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L407 | 6. 已接受的一对一聊天保留。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L608 | 1. 排除当前用户本人； | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L609 | 2. 仅保留同园区且身份有效的用户； | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L610 | 3. 仅保留同一天、状态为 active 的同行意向； | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L611 | 4. 仅保留出发时间落在双方可接受窗口内的记录； | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L612 | 5. 排除已被当前用户屏蔽或已屏蔽当前用户的对象； | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L613 | 6. 排除与当前用户属于同一同行组的成员； | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L614 | 7. 将已组队成员合并为一个同行组候选，不得重复显示个人卡片； | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L615 | 8. 排除没有任何兼容同行方案的候选； | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L616 | 9. 排除路线方向明显相反或共同路段低于最低阈值的候选。 | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L965 | 1. **A：阶段一服务端基础** | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L967 | 2. **B：阶段一桌面端与消息请求** | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L969 | 3. **C：阶段一模块目录与园区试点** | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L971 | 4. **D：阶段二两人同行** | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |
| L973 | 5. **E：阶段三多人组队** | [三阶段组件](evidence/repair-pass-2-desktop-final.log)；[正常 App 登录](evidence/repair-pass-2-normal-app-registered.log)。逐操作真实地图链路按 [APP 清单](live-acceptance-checklist.md)；尚未完整验收。 |

## PRD 现状表（历史描述，不当作新验收结果）

- L43：`| 产品环节 | 当前真实状态 | 拼车助手的接入结论 |`
- L45：`| 右侧模块工作区 | 已有功能组、模块超市、添加/删除/排序和本地布局持久化 | 新增唯一模块 `park-carpool`，名称“拼车助手”；不新建左侧一级导航，不在右栏直接承载复杂业务页 |`
- L46：`| 园区模块目录 | 已有 `park-*` 模块、园区权限判定和模块激活链路 | 复用目录与权限判定，但新增独立激活目标；不将同行视为公告、报修或申请工单 |`
- L47：`| “园区服务”功能组 | 当前官方整组包名为“宏创园区服务”，只允许北控宏创科技园成员安装，且不会对所有企业自动安装 | “拼车助手”的模块能力应面向所有已启用园区服务且已绑定园区的企业；当前已有“园区服务”组时进入该组，无该组时可从模块超市添加。若首批只在宏创园区试点，再单独升级宏创官方组包，不应用该组包限制未来的通用产品能力 |`
- L48：`| 园区业务面板 | 现有 `ParkServicesPlugin` 长期挂载，承载公告、调查、工单、申请和统计等多种业务 | 拼车助手是持续匹配、组队和沟通业务，不复用工单数据模型。新建独立 `ParkCarpoolDialog`，由 App 的统一模块弹窗状态打开，避免继续扩大现有园区插件 |`
- L49：`| 园区身份 | 服务端已能校验企业是否开启 `park_service`，以及企业是否绑定 `parkId` | 直接复用该授权边界；所有发布、查询、邀请和消息操作必须在服务端重新校验，不信任前端传入的 `parkId` |`
- L50：`| “我的消息” | 已有页面外壳、企业内成员目录和同一企业内的 1:1 加密私聊；现有筛选是“全部/未读/已处理” | 只复用页面壳、通知入口和可兼容的加密传输接口；“消息请求”、跨企业 1:1 联系和同行群聊当前均不存在，必须新增服务端模型和授权规则 |`
- L51：`| 地图与定位 | 代码库中没有现成地图 Provider、地点检索、路线规划或重合度实现；Electron 主进程当前只允许音频权限，地理位置被默认拒绝 | 新增服务端 `MapProvider` 适配层和最小化路线数据模型；同时修改 macOS/Windows 的权限说明与 Electron 授权链路。定位必须由用户点击“使用当前位置”后才请求，拒绝后仍可手动选点 |`
- L52：`| 同行服务端 | 当前不存在同行意向、匹配、同行组、入组申请或相关 API | 新建独立 `park_carpool` 业务模块、数据表、路由和审计边界；不将这些数据存入右栏的本地布局存储，也不借用报修工单表 |`
- L482：`| 现有代码位置 | 处理方式 |`
- L484：`| `packages/desktop/src/renderer/moduleCatalog.ts` | 增加模块定义、可用性规则和激活类型 |`
- L485：`| `packages/desktop/src/renderer/moduleGroupCatalog.ts` | 仅在确定宏创园区试点时升级宏创官方组包；通用模块可用性不受该专用组包绑定 |`
- L486：`| `packages/desktop/src/renderer/moduleWorkspace.ts` | 定义已有园区组的布局升级策略，不强制重置用户整个布局 |`
- L487：`| `packages/desktop/src/renderer/moduleModal.ts` 与 `App.tsx` | 增加唯一的 `park-carpool` 弹窗状态和激活分支 |`
- L488：`| `packages/desktop/src/renderer/components/ParkServicesPlugin.tsx` | 保留既有公告、调查、工单和统计逻辑；不把同行的长周期状态塞入该组件 |`
- L489：`| `packages/desktop/src/renderer/components/InboxPage.tsx` | 保留现有企业内私聊，增加消息请求和同行会话的视图适配，不用前端假数据模拟 |`
- L490：`| `packages/server/src/modules/park_services` | 只复用园区成员、园区授权和数据边界；不复用工单 Repository |`
- L491：`| `packages/server/src/modules/collaboration` | 复用通用加密与通知基础；新增能支持跨企业授权和多成员会话的实现，不放宽现有企业内私聊的隔离条件 |`
- L492：`| `packages/server/src/modules/park_carpool` | 新增的同行核心模块，拥有自己的 Schema、Repository、Facade 和路由组合 |`
- L593：`| 能力 | 路由 | 授权要求 |`
- L595：`| 地点搜索/路线规划 | `/enterprise/park-carpool/map/*` | 有效会话 + 有效园区绑定；地图密钥只存在服务端 |`
- L596：`| 发布/修改/停止意向 | `/enterprise/park-carpool/intents` | 只能操作本账号意向；`parkId`由服务端会话推导 |`
- L597：`| 查询匹配 | `/enterprise/park-carpool/matches` | 必须存在本账号有效意向；只返回同园区脱敏结果 |`
- L598：`| 邀请/入组/退出 | `/enterprise/park-carpool/groups/*` | 服务端校验成员资格、人数上限、重复申请和并发版本 |`
- L599：`| 消息请求 | `/enterprise/park-carpool/message-requests/*` | 发送方与接收方必须对应有效匹配或同行邀请；限流、屏蔽和审计 |`
- L600：`| 同行会话 | `/enterprise/park-carpool/conversations/*` | 只有已接受请求或已入组成员可读写；服务端强制历史可见边界 |`
- L620：`| 双方个人意向 | 可形成的同行组方式 | 结果 |`
- L622：`| 一方 `driver`，另一方 `rider` | `private_vehicle` | 可匹配，邀请卡明确“搭车同行”及司机 |`
- L623：`| 双方都选择 `shared_taxi` | `shared_taxi` | 可匹配，邀请卡明确“一起叫车” |`
- L624：`| 双方只选择 `driver` | 无 | 不自动假设其中一人放弃开车，不作为可邀请候选 |`
- L625：`| 双方只选择 `rider` | 无 | 双方都在找车，不作为可邀请候选 |`
- L626：`| 双方有多个选项，同时可形成一种或两种搭车方向，也可叫车 | 多种 | 结果卡展示兼容方案，发送邀请时选定方式；私家车同行同时选定司机 |`

## 公式与非列表规范

PairOverlap 的对称共同区间与时间独立性对应 PRD-047、200–202、218、ADD-01/02；私家车、叫车公式与阈值对应 PRD-203–212、343–344、ADD-11。Domain/GroupMatching 测试证明合成几何计算；真实路网、真实时长与供应商许可尚未验收。流程图/页面线框通过相邻阶段条目追踪，不以存在 JSX 视为像素或完整交互验收。
