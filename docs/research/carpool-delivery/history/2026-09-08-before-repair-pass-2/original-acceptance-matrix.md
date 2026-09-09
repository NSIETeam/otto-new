# 拼车需求追踪与验收矩阵

来源：Otto-拼车助手-产品需求文档.md v1.2，按原文条目保留，不删减验收要求。本次验收结论：阶段一部分完成，阶段二、三未实现，整体不通过。未实现不是外部阻塞。此表保留 367 个原文项目，另附补充规则表；复合项只要仍有缺口即不标完成。

| 需求编号 | 所属章节／阶段 | 用户行为与规则 | 实现位置 | 验收场景与执行证据 | 状态 |
|---|---|---|---|---|---|
| PRD-001 | L25 · 需求描述 | 查看多个个人或同行小组的匹配结果； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-002 | L26 · 需求描述 | 查看双方或自己与同行组之间的路线重合情况； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-003 | L27 · 需求描述 | 给个人发送消息或邀请同行； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-004 | L28 · 需求描述 | 联系同行组的司机或协调人，或申请加入同行组； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-005 | L29 · 需求描述 | 在接受陌生人的消息请求后进行 App 内一对一沟通； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-006 | L30 · 需求描述 | 在后续阶段正式加入同行组后进入同行群聊； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-007 | L31 · 需求描述 | 修改或停止自己的同行意向。 | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-008 | L70 · 版本决策 | 拼车助手是“右侧功能组中的模块”，不是新功能组，也不是左侧导航页。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-009 | L71 · 版本决策 | 模块的可见性来自企业版、`park_service` 功能开关、服务器授权和真实园区绑定；未授权时应隐藏或禁用，不允许用本地假数据绕过。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-010 | L72 · 版本决策 | 右栏布局只保存“模块放在哪个组、顺序如何”；同行意向、匹配结果、同行组和消息必须保存在服务端。 | park_carpool 模块；两个 Repository；MapProvider 接口 | 仅意向和搜索/驾车规划已接通；组、请求、逆编码、预览、调用审计仍缺失 | 部分完成 |
| PRD-011 | L73 · 版本决策 | 功能开启后，用户即使从右栏移除模块，也只是移除入口，不会删除业务数据；用户可从模块超市再次添加。若用户存在有效同行意向或已加入同行组，移除前必须明确提示；移除后仍须在“我的消息”保留“当前同行状态”入口，保证用户能够停止寻找、退组或处理请求。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-012 | L83 · 2. 产品目标 | 让用户在一分钟内完成一次同行意向发布； | ParkCarpoolDialog.tsx | 未执行真实用户一分钟发布计时 | 未实测 |
| PRD-013 | L84 · 2. 产品目标 | 让用户直观看到“谁与我同路、同路多少、时间相差多少”； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-014 | L85 · 2. 产品目标 | 支持个人逐步组成 2 人、3 人或 4 人同行组； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-015 | L86 · 2. 产品目标 | 允许用户在 Otto 内完成首次联系和同行协商； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-016 | L87 · 2. 产品目标 | 在建立联系的同时控制精确地址、联系方式和聊天权限； | parkCarpoolDomain.ts | 不再透出自由输入住宅标签；当前仅通用隐藏提示，不是标准安全区域/地图预览 | 部分完成 |
| PRD-017 | L88 · 2. 产品目标 | 不破坏 Otto 既有消息、企业身份、模块工作区和园区服务能力。 | 原有 Inbox、enterprise-mls、mlsTransportRepository、otto-native/src/mls.rs | server/desktop/native-regression.log：选定原有回归通过；未覆盖全部真机/联邦链路 | 兼容性局部回归通过；新沟通能力未实现 |
| PRD-018 | L96 · 阶段一：首发 V1（最小可用闭环） | 已认证用户发布当日单程同行意向； | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-019 | L97 · 阶段一：首发 V1（最小可用闭环） | 按园区、日期、时间、出行选择和路线筛选个人候选； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-020 | L98 · 阶段一：首发 V1（最小可用闭环） | 展示多个个人结果、路线重合度、时间差、共同里程与信息新鲜度； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-021 | L99 · 阶段一：首发 V1（最小可用闭环） | 提供路线对比与“为什么匹配”说明； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | 只有几何近似解释与统计；无真实路线对比、分岔与地图展示 | 部分完成 |
| PRD-022 | L100 · 阶段一：首发 V1（最小可用闭环） | 支持陌生人消息请求，接受后建立一对一会话； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-023 | L101 · 阶段一：首发 V1（最小可用闭环） | 支持意向修改、停止、自动过期、屏蔽与举报。 | parkCarpoolService.ts；ParkCarpoolDialog.tsx | 修改/停止/读时过期过滤通过；缺持久过期任务、通知、屏蔽举报 | 部分完成 |
| PRD-024 | L105 · 阶段二：两人同行关系 | 支持结构化同行邀请； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-025 | L106 · 阶段二：两人同行关系 | 明确“谁开车”或“一起叫车”； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-026 | L107 · 阶段二：两人同行关系 | 双方确认后形成 2 人同行关系； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-027 | L108 · 阶段二：两人同行关系 | 私家车同行在首次接受或创建邀请时补充本次剩余可同行人数。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-028 | L112 · 阶段三：3–4 人同行组 | 支持个人与同行组的路线匹配； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-029 | L113 · 阶段三：3–4 人同行组 | 支持入组申请、容量控制、协调人转交和同行群聊； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-030 | L114 · 阶段三：3–4 人同行组 | 新成员仅能查看加入后的群聊消息。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-031 | L118 · 4. 产品不包含 | 费用计算、AA 分摊、收款或支付； | 范围约束 | 本次未新增支付、导航、资质、跨园区公开匹配、周期或组间合并 | 范围外；保持排除 |
| PRD-032 | L119 · 4. 产品不包含 | 平台抽佣、担保、保险或事故责任处理； | 范围约束 | 本次未新增支付、导航、资质、跨园区公开匹配、周期或组间合并 | 范围外；保持排除 |
| PRD-033 | L120 · 4. 产品不包含 | 实时车辆调度、接单、抢单或司机派单； | 范围约束 | 本次未新增支付、导航、资质、跨园区公开匹配、周期或组间合并 | 范围外；保持排除 |
| PRD-034 | L121 · 4. 产品不包含 | 全程实时 GPS 追踪或完整导航； | 范围约束 | 本次未新增支付、导航、资质、跨园区公开匹配、周期或组间合并 | 范围外；保持排除 |
| PRD-035 | L122 · 4. 产品不包含 | 车牌、车型、车主资质或车辆所有权认证； | 范围约束 | 本次未新增支付、导航、资质、跨园区公开匹配、周期或组间合并 | 范围外；保持排除 |
| PRD-036 | L123 · 4. 产品不包含 | 跨园区公开匹配； | 范围约束 | 本次未新增支付、导航、资质、跨园区公开匹配、周期或组间合并 | 范围外；保持排除 |
| PRD-037 | L124 · 4. 产品不包含 | 长期固定班车、周期性通勤计划； | 范围约束 | 本次未新增支付、导航、资质、跨园区公开匹配、周期或组间合并 | 范围外；保持排除 |
| PRD-038 | L125 · 4. 产品不包含 | 同行组之间的合并。 | 范围约束 | 本次未新增支付、导航、资质、跨园区公开匹配、周期或组间合并 | 范围外；保持排除 |
| PRD-039 | L129 · 5. 产品假设 | 阶段三的一起叫车组人数上限暂按 **4 人**设计，并由服务端配置；私家车组的容量由司机在本次行程中选择 1 / 2 / 3 名乘客； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-040 | L130 · 5. 产品假设 | 默认匹配时间窗口为用户期望出发时间前后 **30 分钟**，用户可选择更窄的范围； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-041 | L131 · 5. 产品假设 | 只有完成园区身份认证的用户才能发布、查看结果和发送消息； | parkCarpoolService.ts；SQLite/PostgreSQL Principal 适配 | 已测试禁用、未绑定、跨园区与伪造 accountId；消息授权未实现 | 部分完成 |
| PRD-042 | L132 · 5. 产品假设 | 地图服务首发优先考虑高德地图服务，但正式接入前必须完成商务、许可、数据缓存和衍生计算合规确认； | AMap Provider；design-decisions.md | 缺已授权真实测试凭据、地图供应商缓存/衍生计算许可证明；无真实供应商验收 | 外部条件未满足；相关完整代码亦未完成 |
| PRD-043 | L133 · 5. 产品假设 | “接受聊天”与“接受同行”是两个独立授权动作。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-044 | L137 · 6. 核心术语 | **同行意向**：用户针对某一天、某条路线和某个时间段发布的有效记录。 | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-045 | L138 · 6. 核心术语 | **个人候选**：已发布同行意向但尚未加入同行组的单个用户。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-046 | L139 · 6. 核心术语 | **同行组**：至少有 2 名已确认成员的临时同行单元。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-047 | L140 · 6. 核心术语 | **路线重合度**：两条同方向路线的共同路段占双方路线的对称比例。 | parkCarpoolDomain.ts；parkCarpoolRouteGeometry.ts | sampling-red/green.log、server-regression.log：3.9%、反向、平行、交叉、密度、短绕行；未达到真实路网级验证 | 几何近似已修复；真实地图未实测 |
| PRD-048 | L141 · 6. 核心术语 | **出行选择**：用户个人可以接受的选择，包括“我有车”“搭车”和“一起叫车”，用户可多选。“我有车”表示本次可以由用户开车并顺路带人，“搭车”表示乘坐其他同行者的车，“一起叫车”表示匹配后共同叫第三方车辆。 | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-049 | L142 · 6. 核心术语 | **同行组方式**：同行组成立后确定的实际方式，只有“私家车同行”或“一起叫车”两类。私家车同行还必须明确由哪位成员开车。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-050 | L143 · 6. 核心术语 | **消息请求**：陌生用户发出的第一条消息或结构化邀请，在接收者接受前不进入正常会话。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-051 | L144 · 6. 核心术语 | **结构化邀请**：包含路线、时间和操作按钮的同行邀请或入组申请消息。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-052 | L156 · 1. 模块入口 | 用户已安装“园区服务”功能组：通过一次性布局迁移将“拼车助手”预添加到该组，但保留用户对其他模块的排序和分组。用户主动移除后不得被后续升级重复加回。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | 仅宏创官方组迁移有现有实现与回归；其他园区组预添加未完成，真机未测 | 部分完成 |
| PRD-053 | L157 · 1. 模块入口 | 用户没有该功能组：在模块超市的“园区服务”分类中展示，用户可将它添加到任意自定义组。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-054 | L158 · 1. 模块入口 | 用户具备权限但从未安装过该模块：可在模块超市或园区服务入口展示一次非阻断推荐，不强制新建功能组。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-055 | L159 · 1. 模块入口 | 个人版、未开启 `park_service`、未绑定园区或服务器未授权：不展示可执行入口；若因授权暂时不可用而保留布局占位，则展示明确的禁用原因。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-056 | L165 · 1. 模块入口 | 无有效意向且未加入同行组：按现有模块删除逻辑直接移除； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-057 | L166 · 1. 模块入口 | 存在有效意向或同行组：提示“只会移除右侧入口，不会停止寻找或退出同行组”，用户确认后才移除； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-058 | L167 · 1. 模块入口 | 移除后，“我的消息”中持续展示当前同行状态卡，卡片可进入结果、停止寻找或退出同行组。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-059 | L197 · 2. 发布页 | 园区试点中，出发地默认按“当前园区 → 园区出口/公共集合点 → 当前位置 → 其他地点”的顺序引导； | ParkCarpoolDialog.tsx | 只有手动搜索；缺管理员集合点、定位与选点 | 未完成 |
| PRD-060 | L198 · 2. 发布页 | 定位只是快速填写辅助，不得默认将办公室、地下车库或园区内部坐标视为真实上车点； | ParkCarpoolDialog.tsx | 只有手动搜索；缺管理员集合点、定位与选点 | 未完成 |
| PRD-061 | L199 · 2. 发布页 | 优先引导选择公共集合点，使用当前位置失败时允许手动搜索； | ParkCarpoolDialog.tsx | 只有手动搜索；缺管理员集合点、定位与选点 | 未完成 |
| PRD-062 | L200 · 2. 发布页 | 目的地不能假设为当前定位，必须由用户搜索地点、输入地址或地图选点； | ParkCarpoolDialog.tsx；parkCarpoolConversationBridge.ts | 多候选显式选择；对话真实服务契约通过；真实地图及地图选点未完成 | 部分完成 |
| PRD-063 | L201 · 2. 发布页 | 搜索建议必须让用户明确选择一个标准地点，避免仅保存模糊文本； | ParkCarpoolDialog.tsx；parkCarpoolConversationBridge.ts | 多候选显式选择；对话真实服务契约通过；真实地图及地图选点未完成 | 部分完成 |
| PRD-064 | L202 · 2. 发布页 | 出行选择为必选、可多选的并列选项，不使用下拉菜单隐藏； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-065 | L203 · 2. 发布页 | 三个选项统一使用简短名称：“我有车”映射为愿意在本次行程中作为司机并顺路带人，“搭车”映射为乘坐其他同行者的车，“一起叫车”映射为与同行者自行协调第三方叫车； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-066 | L204 · 2. 发布页 | “我有车”不能只按车辆所有权解释。选项下方或首次选择时必须说明“可以由我开车并顺路带人”，避免用户仅因名下有车而误选；“搭车”须说明“搭乘同行伙伴的车”，避免与“一起叫车”混淆； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-067 | L205 · 2. 发布页 | 多选时在选项下明示“表示本次这几种方式都可以”； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-068 | L206 · 2. 发布页 | “一起叫车”只表示用户愿意在匹配后自行协商叫车，Otto 不叫车、不计费、不处理费用分摊； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-069 | L207 · 2. 发布页 | “先聊聊”不是同行方式，不放在本选择区；用户在结果卡片上通过“发消息”完成先沟通再决定。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-070 | L208 · 2. 发布页 | “发布并查找同路伙伴”明确表达提交同时具有发布行为； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-071 | L209 · 2. 发布页 | 发布前展示可见范围和隐私说明； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-072 | L210 · 2. 发布页 | 不在首屏要求用户填写费用、座位、车牌等非核心信息；私家车座位容量只在用户首次确认私家车同行时询问。 | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-073 | L242 · 3. 结果页 | 阶段一只展示个人候选；阶段三开启后，个人和同行组显示在同一列表中，统一按当前用户的个性化路线重合度排序； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-074 | L243 · 3. 结果页 | 卡片必须明确显示人数，个人显示“1 人”，同行组显示“2 人同行”“3 人同行”等； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-075 | L244 · 3. 结果页 | 时间差和路线重合度分别展示，不合并成难以解释的综合分； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-076 | L245 · 3. 结果页 | 卡片不复制对方的第一人称选项，而是直接描述与当前用户的关系：“你可以搭李某的车”“李某可以搭你的车”“你们可以一起叫车”或“有 2 种同行方案”； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-077 | L246 · 3. 结果页 | 若双方存在多种兼容方案，发送邀请时必须选定本次方式及私家车司机； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-078 | L247 · 3. 结果页 | 同行组卡片显示该组已确定的方式，组队后不再显示为含糊的“都可以”； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-079 | L248 · 3. 结果页 | 私家车同行组必须显示司机和剩余可同行人数；一起叫车组显示协调人； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-080 | L249 · 3. 结果页 | 所有卡片显示身份认证和信息新鲜度，包括“刚刚更新”“5 分钟前仍在寻找”“即将出发”“已停止”；停止或过期记录不可继续操作； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-081 | L250 · 3. 结果页 | 结果页提供“全部／可搭车／可带人／一起叫车”轻量筛选； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-082 | L251 · 3. 结果页 | 路线重合度四舍五入为整数并使用“约”表达，同时提供“为什么匹配”说明，不向用户营造虚假精度； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-083 | L252 · 3. 结果页 | 已组成同行组的成员不再以个人候选重复出现； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-084 | L253 · 3. 结果页 | 当前用户已加入的同行组固定展示在顶部“我的同行组”，不再作为普通结果出现； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-085 | L254 · 3. 结果页 | 有新结果时显示“发现 N 个新同行结果”，由用户点击后刷新，避免阅读过程中列表突然跳动。 | ParkCarpoolDialog.tsx | 30 秒轮询先计数、用户点击刷新；无服务端通知事实与重试 | 代码部分完成；轮询真机未实测 |
| PRD-086 | L260 · 4. 路线对比页 | 深色路线：双方或全组成员高度重合的路段； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-087 | L261 · 4. 路线对比页 | 浅色路线：仅与部分成员重合的路段； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-088 | L262 · 4. 路线对比页 | 灰色路线：当前用户单独经过的路段； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-089 | L263 · 4. 路线对比页 | 展示共同方向里程、路线重合度及主要分岔位置； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | 只有几何近似解释与统计；无真实路线对比、分岔与地图展示 | 部分完成 |
| PRD-090 | L264 · 4. 路线对比页 | 地图下方同时提供文字摘要，例如“你们在北五环至回龙观主干路段大致同向，主要分岔点位于……”，不要求用户必须依赖地图颜色理解结果； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | 只有几何近似解释与统计；无真实路线对比、分岔与地图展示 | 部分完成 |
| PRD-091 | L265 · 4. 路线对比页 | 默认隐藏精确住宅门牌和精确起终点，使用模糊区域或经过脱敏的地图标记； | parkCarpoolDomain.ts | 不再透出自由输入住宅标签；当前仅通用隐藏提示，不是标准安全区域/地图预览 | 部分完成 |
| PRD-092 | L266 · 4. 路线对比页 | 同行组详情可展开查看当前用户与每位成员的两两重合度。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-093 | L294 · 5. 我的同行组 | 人数只统计已确认成员，待处理邀请不提前计入； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-094 | L295 · 5. 我的同行组 | 私家车同行以司机设置的乘客容量为准；一起叫车以服务端配置的组人数上限为准。达到容量后显示“已满”，停止接收入组申请； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-095 | L296 · 5. 我的同行组 | 私家车同行由司机管理容量和入组申请；一起叫车由发起人担任协调人； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-096 | L297 · 5. 我的同行组 | 协调人退出前必须主动选择转交对象，且对方明确接受后才完成转交；不允许按“最早加入”自动指定； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-097 | L298 · 5. 我的同行组 | 无人接受转交时，该组停止接收新成员，已有成员和会话保留到行程结束； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-098 | L299 · 5. 我的同行组 | 私家车司机退出时，只能将司机角色转交给已明确选择 `driver` 且接受转交的成员；否则该组关闭新申请并提示成员重新协商； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-099 | L300 · 5. 我的同行组 | 最后一名成员退出后，同行组关闭，成员恢复为个人意向或由用户选择停止寻找。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-100 | L347 · 6. 我的消息与消息请求 | 当前 `InboxPage` 的私聊对象来自本企业成员目录，服务端也要求发送方和接收方属于同一 `organizationId`。拼车助手不得直接调用该接口联系其他公司员工，否则必然返回“成员不存在”或越权错误。 | 原有 Inbox、enterprise-mls、mlsTransportRepository、otto-native/src/mls.rs | server/desktop/native-regression.log：选定原有回归通过；未覆盖全部真机/联邦链路 | 兼容性局部回归通过；新沟通能力未实现 |
| PRD-101 | L348 · 6. 我的消息与消息请求 | 新增园区范围的有限身份目录，只向已发布有效同行意向的匹配用户暴露脱敏姓名、企业名和必要匹配摘要，不暴露整个园区人员目录。 | parkCarpoolService.ts；SQLite/PostgreSQL Principal 适配 | 已测试禁用、未绑定、跨园区与伪造 accountId；消息授权未实现 | 部分完成 |
| PRD-102 | L349 · 6. 我的消息与消息请求 | 新增 `MessageRequest` 持久化与状态机，未接受前不得建立普通会话。不得仅靠前端标签伪造“消息请求”。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-103 | L350 · 6. 我的消息与消息请求 | 新增可表达 2—4 人成员关系的同行群会话模型。当前的 `direct_messages` 和 `mls_conversations` 均是两人模型，不能通过修改页面文案变成群聊。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-104 | L351 · 6. 我的消息与消息请求 | 可复用现有的未读通知、附件限制、设备密钥与 MLS 传输实现中的通用能力，但群成员管理、跨企业授权、入组后密钥更新和历史可见性必须单独设计与测试。 | 原有 Inbox、enterprise-mls、mlsTransportRepository、otto-native/src/mls.rs | server/desktop/native-regression.log：选定原有回归通过；未覆盖全部真机/联邦链路 | 兼容性局部回归通过；新沟通能力未实现 |
| PRD-105 | L415 · P0 用户故事（阶段一） | 作为园区员工，我希望能优先选择当前园区出口或公共集合点，也能使用当前位置或手动选点，以便填写真实上车位置。 | ParkCarpoolDialog.tsx | 只有手动搜索；缺管理员集合点、定位与选点 | 未完成 |
| PRD-106 | L416 · P0 用户故事（阶段一） | 作为园区员工，我希望能够搜索并确认目的地，而不是把当前位置误认为目的地。 | ParkCarpoolDialog.tsx；parkCarpoolConversationBridge.ts | 多候选显式选择；对话真实服务契约通过；真实地图及地图选点未完成 | 部分完成 |
| PRD-107 | L417 · P0 用户故事（阶段一） | 作为园区员工，我希望可以选择一种或多种我能接受的出行选择，以便系统只展示实际可执行的匹配方案。 | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-108 | L418 · P0 用户故事（阶段一） | 作为寻找同行的人，我希望提交后看到多个匹配对象，而不是只看到一个推荐结果。 | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-109 | L419 · P0 用户故事（阶段一） | 作为寻找同行的人，我希望结果按与我的路线重合度排序，以便优先联系最顺路的人。 | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-110 | L420 · P0 用户故事（阶段一） | 作为寻找同行的人，我希望卡片直接告诉我“我们可以怎么同行”，而不是显示对方难以理解的第一人称选项。 | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-111 | L421 · P0 用户故事（阶段一） | 作为寻找同行的人，我希望看到对方的身份认证和信息更新时间，避免联系已经出发或停止寻找的用户。 | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-112 | L422 · P0 用户故事（阶段一） | 作为收到陌生消息的人，我希望第一条消息进入“消息请求”，由我决定是否接受。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-113 | L423 · P0 用户故事（阶段一） | 作为用户，我希望接受聊天不会自动代表接受同行。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-114 | L424 · P0 用户故事（阶段一） | 作为重视隐私的用户，我希望在确认联系前不暴露精确住址和联系方式。 | parkCarpoolDomain.ts | 不再透出自由输入住宅标签；当前仅通用隐藏提示，不是标准安全区域/地图预览 | 部分完成 |
| PRD-115 | L425 · P0 用户故事（阶段一） | 作为已发布意向的用户，我希望能够随时修改或停止寻找。 | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-116 | L426 · P0 用户故事（阶段一） | 作为移除了模块的用户，我希望仍能在“我的消息”管理当前同行状态。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-117 | L427 · P0 用户故事（阶段一） | 作为用户，我希望新候选出现时收到轻量提示，但当前阅读位置不要突然改变。 | ParkCarpoolDialog.tsx | 30 秒轮询先计数、用户点击刷新；无服务端通知事实与重试 | 代码部分完成；轮询真机未实测 |
| PRD-118 | L428 · P0 用户故事（阶段一） | 作为用户，我希望能够屏蔽或举报骚扰者。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-119 | L432 · P1 用户故事（阶段二与阶段三） | 作为园区员工，我希望邀请卡明确本次是“谁开车”还是“一起叫车”，避免接受后才发现双方理解不同。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-120 | L433 · P1 用户故事（阶段二与阶段三） | 作为私家车司机，我希望只填写本次可同行乘客数，防止系统超员组队，而不需上传车牌或车辆材料。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-121 | L434 · P1 用户故事（阶段二与阶段三） | 作为用户，我希望区分个人和已有同行组，并看到当前人数。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-122 | L435 · P1 用户故事（阶段二与阶段三） | 作为个人用户，我希望可以邀请另一个人同行，双方确认后组成 2 人同行关系。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-123 | L436 · P1 用户故事（阶段二与阶段三） | 作为寻找同行的人，我希望可以申请加入已有同行组。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-124 | L437 · P1 用户故事（阶段二与阶段三） | 作为同行组成员，我希望通过 App 内群聊协商时间和集合地点。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-125 | L438 · P1 用户故事（阶段二与阶段三） | 作为私家车司机或一起叫车协调人，我希望能够处理入组申请和待确认邀请。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-126 | L439 · P1 用户故事（阶段二与阶段三） | 作为同行组成员，我希望能够退出小组，并明确退出后的意向状态。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-127 | L440 · P1 用户故事（阶段二与阶段三） | 作为产品运营人员，我希望组人数、匹配时间窗口和最低重合度可配置。 | createParkCarpoolService.minimumOverlap | 仅个人最低重合阈值可注入；无完整配置、陈旧提醒/降序和组阈值 | 未完成 |
| PRD-128 | L469 · 1. 总体架构 | `moduleCatalog` 新增 `park-carpool` 目录项、独立图标和独立弹窗激活类型；不把它冒充为现有 `ParkModuleTarget` 工单页。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-129 | L470 · 1. 总体架构 | App 仍使用单一 `ModuleModalState`，打开拼车助手时关闭其他模块弹窗，避免面板叠加。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-130 | L471 · 1. 总体架构 | `park_carpool` 是有内聚业务规则的深模块；对外只暴露发布意向、列出匹配、查看路线摘要、邀请/入组和管理状态等少量接口。 | park_carpool 模块；两个 Repository；MapProvider 接口 | 仅意向和搜索/驾车规划已接通；组、请求、逆编码、预览、调用审计仍缺失 | 部分完成 |
| PRD-131 | L472 · 1. 总体架构 | `ParkMembershipAdapter` 必须复用服务端已有园区成员关系，不复制一套本地“园区身份”。 | park_carpool 模块；两个 Repository；MapProvider 接口 | 仅意向和搜索/驾车规划已接通；组、请求、逆编码、预览、调用审计仍缺失 | 部分完成 |
| PRD-132 | L473 · 1. 总体架构 | `ParkConversationAdapter` 是同行业务与沟通模块的稳定接缝；不允许同行模块直接向现有 `direct_messages` 表写入跨企业数据。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-133 | L474 · 1. 总体架构 | Renderer 不直接持有地图密钥； | AMap Provider；Desktop CSP | 地图凭据仍由服务端持有；未引入第三方脚本或放宽 CSP | 静态自查通过 |
| PRD-134 | L475 · 1. 总体架构 | 不在前端绕过现有 CSP 引入未经控制的第三方地图脚本； | AMap Provider；Desktop CSP | 地图凭据仍由服务端持有；未引入第三方脚本或放宽 CSP | 静态自查通过 |
| PRD-135 | L476 · 1. 总体架构 | 地图密钥、配额、签名和调用审计由服务端管理； | park_carpool 模块；两个 Repository；MapProvider 接口 | 仅意向和搜索/驾车规划已接通；组、请求、逆编码、预览、调用审计仍缺失 | 部分完成 |
| PRD-136 | L477 · 1. 总体架构 | MapProvider 必须抽象为可替换接口，至少包含地点搜索、逆地理编码、驾车路线规划和路线预览数据生成； | park_carpool 模块；两个 Repository；MapProvider 接口 | 仅意向和搜索/驾车规划已接通；组、请求、逆编码、预览、调用审计仍缺失 | 部分完成 |
| PRD-137 | L478 · 1. 总体架构 | 正式实现路线缓存、重合度衍生计算前，必须确认地图供应商许可范围。 | AMap Provider；design-decisions.md | 缺已授权真实测试凭据、地图供应商缓存/衍生计算许可证明；无真实供应商验收 | 外部条件未满足；相关完整代码亦未完成 |
| PRD-138 | L498 · CommuteIntent（同行意向） | `id` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-139 | L499 · CommuteIntent（同行意向） | `accountId` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-140 | L500 · CommuteIntent（同行意向） | `organizationId` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-141 | L501 · CommuteIntent（同行意向） | `parkId` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-142 | L502 · CommuteIntent（同行意向） | `travelDate` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-143 | L503 · CommuteIntent（同行意向） | `originLabel` / `originCoordinate` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-144 | L504 · CommuteIntent（同行意向） | `destinationLabel` / `destinationCoordinate` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-145 | L505 · CommuteIntent（同行意向） | `departureTime` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-146 | L506 · CommuteIntent（同行意向） | `flexibleMinutes` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-147 | L507 · CommuteIntent（同行意向） | `travelOptions`（必填数组，可多选、去重）：driver / rider / shared_taxi | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-148 | L508 · CommuteIntent（同行意向） | `routePolylineRef` | park_carpool 模块；两个 Repository；MapProvider 接口 | 仅意向和搜索/驾车规划已接通；组、请求、逆编码、预览、调用审计仍缺失 | 部分完成 |
| PRD-149 | L509 · CommuteIntent（同行意向） | `status`：active / paused / grouped / expired | park_carpool 模块；两个 Repository；MapProvider 接口 | 仅意向和搜索/驾车规划已接通；组、请求、逆编码、预览、调用审计仍缺失 | 部分完成 |
| PRD-150 | L510 · CommuteIntent（同行意向） | `lastConfirmedAt`：最近一次由用户编辑、发布或点击“仍在寻找”的时间 | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-151 | L511 · CommuteIntent（同行意向） | `expiresAt` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-152 | L512 · CommuteIntent（同行意向） | `createdAt` / `updatedAt` | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-153 | L518 · CarpoolGroup（同行组） | `id` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-154 | L519 · CarpoolGroup（同行组） | `parkId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-155 | L520 · CarpoolGroup（同行组） | `coordinatorAccountId`：私家车同行为司机；一起叫车为发起人或已接受转交的协调人 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-156 | L521 · CarpoolGroup（同行组） | `coordinatorOrganizationId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-157 | L522 · CarpoolGroup（同行组） | `travelMode`：private_vehicle / shared_taxi | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-158 | L523 · CarpoolGroup（同行组） | `driverAccountId`：私家车同行必填；一起叫车必须为空 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-159 | L524 · CarpoolGroup（同行组） | `memberCount` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-160 | L525 · CarpoolGroup（同行组） | `passengerCapacity`：私家车必填，表示本次最多可接受的乘车成员数，首版允许 1 / 2 / 3 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-161 | L526 · CarpoolGroup（同行组） | `confirmedPassengerCount`：私家车中已确认的非司机成员数 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-162 | L527 · CarpoolGroup（同行组） | `maxMembers`：一起叫车组的服务端配置上限 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-163 | L528 · CarpoolGroup（同行组） | `status`：active / full / closed_to_new_members / closed / expired | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-164 | L529 · CarpoolGroup（同行组） | `groupConversationId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-165 | L530 · CarpoolGroup（同行组） | `createdAt` / `updatedAt` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-166 | L534 · GroupMember（同行组成员） | `groupId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-167 | L535 · GroupMember（同行组成员） | `accountId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-168 | L536 · GroupMember（同行组成员） | `organizationId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-169 | L537 · GroupMember（同行组成员） | `intentId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-170 | L538 · GroupMember（同行组成员） | `role`：coordinator / member | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-171 | L539 · GroupMember（同行组成员） | `status`：pending / accepted / left | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-172 | L540 · GroupMember（同行组成员） | `joinedAt` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-173 | L544 · MessageRequest（消息请求） | `id` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-174 | L545 · MessageRequest（消息请求） | `parkId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-175 | L546 · MessageRequest（消息请求） | `senderAccountId` / `senderOrganizationId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-176 | L547 · MessageRequest（消息请求） | `receiverAccountId` / `receiverOrganizationId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-177 | L548 · MessageRequest（消息请求） | `requestType`：text / carpool_invite / group_join | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-178 | L549 · MessageRequest（消息请求） | `proposedTravelMode`：private_vehicle / shared_taxi（同行邀请必填） | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-179 | L550 · MessageRequest（消息请求） | `proposedDriverAccountId`：私家车同行邀请必填，且必须是邀请双方中选择了 `driver` 的账号 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-180 | L551 · MessageRequest（消息请求） | `intentId` / `groupId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-181 | L552 · MessageRequest（消息请求） | `status`：pending / accepted / ignored / blocked / expired | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-182 | L553 · MessageRequest（消息请求） | `firstMessage` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-183 | L554 · MessageRequest（消息请求） | `expiresAt` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-184 | L558 · ParkConversation（拼车助手会话） | `id` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-185 | L559 · ParkConversation（拼车助手会话） | `parkId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-186 | L560 · ParkConversation（拼车助手会话） | `kind`：direct / group | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-187 | L561 · ParkConversation（拼车助手会话） | `carpoolGroupId`（群会话必填） | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-188 | L562 · ParkConversation（拼车助手会话） | `status`：pending / active / archived / blocked | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-189 | L563 · ParkConversation（拼车助手会话） | `createdAt` / `updatedAt` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-190 | L567 · ParkConversationMember（园区会话成员） | `conversationId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-191 | L568 · ParkConversationMember（园区会话成员） | `accountId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-192 | L569 · ParkConversationMember（园区会话成员） | `organizationId` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-193 | L570 · ParkConversationMember（园区会话成员） | `role`：direct 会话为 participant；group 会话为 coordinator / member | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-194 | L571 · ParkConversationMember（园区会话成员） | `joinedAt` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-195 | L572 · ParkConversationMember（园区会话成员） | `historyVisibleFrom` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-196 | L573 · ParkConversationMember（园区会话成员） | `leftAt` | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-197 | L632 · 出行选择兼容规则 | `private_vehicle`：必须设置唯一 `driverAccountId`，该成员必须仍具有有效 `driver` 意向；其他新成员必须具备 `rider` 选项。司机在首次确认私家车同行时必须选择本次最多可同行乘客数 1 / 2 / 3，服务端按该容量阻止超员；Otto 不采集车牌、车型或费用，也不对座位安全做平台承诺。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-198 | L633 · 出行选择兼容规则 | `shared_taxi`：所有成员都必须选择 `shared_taxi`；Otto 不创建叫车订单，不接收费用，只提供匹配与会话。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-199 | L634 · 出行选择兼容规则 | 用户修改个人 `travelOptions` 时，不得暗中改变已加入同行组的方式；组方式或司机变更需要成员明确确认。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-200 | L642 · 4. 个人与个人的路线重合度 | `C`：双方同方向共同路段长度； | parkCarpoolDomain.ts；parkCarpoolRouteGeometry.ts | sampling-red/green.log、server-regression.log：3.9%、反向、平行、交叉、密度、短绕行；未达到真实路网级验证 | 几何近似已修复；真实地图未实测 |
| PRD-201 | L643 · 4. 个人与个人的路线重合度 | `L1`：当前用户路线总长度； | parkCarpoolDomain.ts；parkCarpoolRouteGeometry.ts | sampling-red/green.log、server-regression.log：3.9%、反向、平行、交叉、密度、短绕行；未达到真实路网级验证 | 几何近似已修复；真实地图未实测 |
| PRD-202 | L644 · 4. 个人与个人的路线重合度 | `L2`：候选用户路线总长度。 | parkCarpoolDomain.ts；parkCarpoolRouteGeometry.ts | sampling-red/green.log、server-regression.log：3.9%、反向、平行、交叉、密度、短绕行；未达到真实路网级验证 | 几何近似已修复；真实地图未实测 |
| PRD-203 | L662 · 5.1 私家车同行 | `DriverOverlap`：当前用户与司机的 `PairOverlap`； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-204 | L663 · 5.1 私家车同行 | `MemberAverageOverlap`：当前用户与组内所有已确认成员的平均重合度，仅作为全组参考； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-205 | L664 · 5.1 私家车同行 | `EstimatedDriverDetour`：候选人加入后可能为司机增加的预计绕行时间。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-206 | L668 · 5.1 私家车同行 | 候选人必须选择 `rider`； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-207 | L669 · 5.1 私家车同行 | `DriverOverlap` 不低于私家车匹配阈值； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-208 | L670 · 5.1 私家车同行 | `EstimatedDriverDetour` 不超过服务端配置的绕行上限； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-209 | L671 · 5.1 私家车同行 | 剩余可同行人数至少为 1。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-210 | L679 · 5.2 一起叫车 | `AverageOverlap`：当前用户与所有组员两两重合度的平均值； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-211 | L680 · 5.2 一起叫车 | `LowestOverlap`：当前用户与组员之间最低的两两重合度； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-212 | L681 · 5.2 一起叫车 | `EstimatedMaxDetour`：加入新成员后，组内任一成员相对直接行程可能增加的最大预计时间。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-213 | L693 · 6. 排序逻辑 | 主排序：路线重合度降序； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-214 | L694 · 6. 排序逻辑 | 第一辅助排序：出发时间绝对差升序； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-215 | L695 · 6. 排序逻辑 | 第二辅助排序：共同方向里程降序； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-216 | L696 · 6. 排序逻辑 | 个人和同行组使用同一排序队列； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-217 | L697 · 6. 排序逻辑 | 个人使用 `PairOverlap`，私家车组使用 `DriverOverlap`，一起叫车组使用 `SharedTaxiGroupOverlap`；只有通过各自硬性可行性条件后才进入统一排序； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-218 | L698 · 6. 排序逻辑 | 时间差单独展示，不进入路线百分比。 | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-219 | L715 · 7. 组队状态流转 | 待确认邀请不计入人数； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-220 | L716 · 7. 组队状态流转 | 用户同时只能作为一个同行组的正式成员； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-221 | L717 · 7. 组队状态流转 | 各阶段都不支持两个同行组合并； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-222 | L718 · 7. 组队状态流转 | 当用户已加入同行组后，邀请个人的按钮改为“邀请加入本组”； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-223 | L719 · 7. 组队状态流转 | 当同行组达到容量上限时，待处理入组申请不得继续通过； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-224 | L720 · 7. 组队状态流转 | 私家车每次接受入组前重新校验 `confirmedPassengerCount < passengerCapacity`； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-225 | L721 · 7. 组队状态流转 | 协调人或司机离开时不得自动转交角色，须完成明确的转交提议与接受；无人接受时将组设为 `closed_to_new_members`。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-226 | L725 · 8. 消息请求与聊天 | 陌生用户第一次联系必须创建消息请求，不得直接创建正常会话； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-227 | L726 · 8. 消息请求与聊天 | 同一发送者对同一接收者只能存在一条待处理请求； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-228 | L727 · 8. 消息请求与聊天 | 请求未接受前，发送者不能连续追加普通消息； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-229 | L728 · 8. 消息请求与聊天 | 接收者可接受、忽略、屏蔽或举报； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-230 | L729 · 8. 消息请求与聊天 | 忽略不向发送者暴露明确结果，发送者仅看到“等待对方接受”或请求过期； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-231 | L730 · 8. 消息请求与聊天 | 接受普通消息请求只开放一对一聊天，不改变同行关系； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-232 | L731 · 8. 消息请求与聊天 | 接受结构化同行邀请才创建 2 人同行组； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-233 | L732 · 8. 消息请求与聊天 | 同意入组申请后才授予同行群聊访问权； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-234 | L733 · 8. 消息请求与聊天 | 请求列表必须直接标记 `text`、`carpool_invite`、`group_join` 三种类型，分别展示“消息请求”“同行邀请”“入组申请”； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-235 | L734 · 8. 消息请求与聊天 | 新成员不得读取加入前的群聊历史； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-236 | L735 · 8. 消息请求与聊天 | 一对一私聊不得被复制到群聊； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-237 | L736 · 8. 消息请求与聊天 | 未处理请求随对应同行意向过期。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-238 | L742 · 9. 实时更新 | 新匹配候选出现； | ParkCarpoolDialog.tsx | 30 秒轮询先计数、用户点击刷新；无服务端通知事实与重试 | 代码部分完成；轮询真机未实测 |
| PRD-239 | L743 · 9. 实时更新 | 消息请求到达； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-240 | L744 · 9. 实时更新 | 同行邀请被接受或拒绝； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-241 | L745 · 9. 实时更新 | 入组申请状态变化； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-242 | L746 · 9. 实时更新 | 同行组成员变化； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-243 | L747 · 9. 实时更新 | 同行意向被修改、停止或过期。 | parkCarpoolService.ts；ParkCarpoolDialog.tsx | 状态读取/卡片新鲜度；无持久业务事件推送 | 部分完成 |
| PRD-244 | L753 · 9. 实时更新 | 用户发布、修改或点击“仍在寻找”时更新 `lastConfirmedAt`； | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-245 | L754 · 9. 实时更新 | 候选卡根据 `lastConfirmedAt`、计划出发时间和 `status` 显示“刚刚更新”“N 分钟前仍在寻找”“即将出发”或“已停止”； | parkCarpoolService.ts；ParkCarpoolDialog.tsx | 状态读取/卡片新鲜度；无持久业务事件推送 | 部分完成 |
| PRD-246 | L755 · 9. 实时更新 | 超过可配置的新鲜度阈值后，系统优先提醒用户确认是否仍在寻找；在重新确认前降低排序或暂停对外展示，不得将过时信息伪装为活跃候选。 | createParkCarpoolService.minimumOverlap | 仅个人最低重合阈值可注入；无完整配置、陈旧提醒/降序和组阈值 | 未完成 |
| PRD-247 | L763 · 1. 输入与校验 | 出发地和目的地必须解析为有效坐标； | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-248 | L764 · 1. 输入与校验 | 两个地点不能完全相同； | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-249 | L765 · 1. 输入与校验 | 出发时间必须处于允许发布的时间范围内； | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-250 | L766 · 1. 输入与校验 | 至少选择一项出行选择；`travelOptions` 仅允许 `driver`、`rider`、`shared_taxi`，服务端必须去重并拒绝未知值； | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-251 | L767 · 1. 输入与校验 | 选择 `driver` 只表示本次意向中愿意开车，不采集车辆所有权、车牌、车型或费用信息；只在首次确认私家车同行时收集本次乘客容量 1 / 2 / 3； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-252 | L768 · 1. 输入与校验 | 定位权限被拒绝时不能阻断功能，应自动引导手动搜索； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-253 | L769 · 1. 输入与校验 | 地点存在歧义时必须要求用户从候选列表选择，不直接使用未解析文本； | ParkCarpoolDialog.tsx；parkCarpoolConversationBridge.ts | 多候选显式选择；对话真实服务契约通过；真实地图及地图选点未完成 | 部分完成 |
| PRD-254 | L770 · 1. 输入与校验 | 发布按钮在路线规划完成前显示处理中状态，防止重复提交； | ParkCarpoolDialog.tsx；parkCarpoolConversationBridge.ts | 组件与对话处理中互斥、错误保留草稿；真实并发由数据库契约验证 | 已实现；本地回归通过 |
| PRD-255 | L771 · 1. 输入与校验 | 重复点击应通过幂等键返回同一发布结果。 | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-256 | L775 · 1. 输入与校验 | 当前 Electron 主进程的权限处理器只允许音频录制，地理位置会被拒绝。实现时必须显式增加 `geolocation` 授权分支，且只对受信任的 Otto 主窗口生效，不放宽摄像头、视频或其他权限。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-257 | L776 · 1. 输入与校验 | macOS 包需增加清晰的位置用途说明，Windows 需按打包框架要求声明位置能力；两端均需真机验收允许、拒绝和后续修改系统权限的状态。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-258 | L777 · 1. 输入与校验 | App 启动、打开右栏或打开拼车助手弹窗时都不得自动弹权限请求；只有用户点击“使用当前位置”才请求。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-259 | L778 · 1. 输入与校验 | 定位拒绝不得使模块整体不可用；手动搜索和选点是同等完整的备选流程。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-260 | L788 · 2. 发布可见性 | 用户昵称或脱敏姓名； | parkCarpoolDomain.ts | 候选投影包含姓名、企业、出发时间；server-regression.log | 现有实现；本地回归通过 |
| PRD-261 | L789 · 2. 发布可见性 | 所属企业； | parkCarpoolDomain.ts | 候选投影包含姓名、企业、出发时间；server-regression.log | 现有实现；本地回归通过 |
| PRD-262 | L790 · 2. 发布可见性 | 大致目的地区域； | parkCarpoolDomain.ts | 不再透出自由输入住宅标签；当前仅通用隐藏提示，不是标准安全区域/地图预览 | 部分完成 |
| PRD-263 | L791 · 2. 发布可见性 | 期望出发时间； | parkCarpoolDomain.ts | 候选投影包含姓名、企业、出发时间；server-regression.log | 现有实现；本地回归通过 |
| PRD-264 | L792 · 2. 发布可见性 | 路线重合度和共同方向里程； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-265 | L793 · 2. 发布可见性 | 同行组人数。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-266 | L797 · 2. 发布可见性 | 住宅门牌号和精确家庭地址； | parkCarpoolDomain.ts | 候选投影不传端点/电话/自由地址；中文门牌与混合门牌回归；地图预览未提供 | 候选投影已修复；完整隐私验收未完成 |
| PRD-267 | L798 · 2. 发布可见性 | 手机号、微信号等外部联系方式； | parkCarpoolDomain.ts | 候选投影不传端点/电话/自由地址；中文门牌与混合门牌回归；地图预览未提供 | 候选投影已修复；完整隐私验收未完成 |
| PRD-268 | L799 · 2. 发布可见性 | 完整精确起终点坐标； | parkCarpoolDomain.ts | 候选投影不传端点/电话/自由地址；中文门牌与混合门牌回归；地图预览未提供 | 候选投影已修复；完整隐私验收未完成 |
| PRD-269 | L800 · 2. 发布可见性 | 未加入同行组前的群聊内容。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-270 | L819 · 4. 地图或路线服务异常 | 地点搜索失败：保留用户已填写内容并提供重试； | parkCarpoolService.ts；ParkCarpoolDialog.tsx；ConversationBridge | 失败保留、无效路线拒绝；成功后刷新失败明确真实发布结果；合成 Provider 本地测试 | 已实现本地失败行为；真实供应商未实测 |
| PRD-271 | L820 · 4. 地图或路线服务异常 | 路线规划失败：不得发布一个无法参与匹配的无路线意向； | parkCarpoolService.ts；ParkCarpoolDialog.tsx；ConversationBridge | 失败保留、无效路线拒绝；成功后刷新失败明确真实发布结果；合成 Provider 本地测试 | 已实现本地失败行为；真实供应商未实测 |
| PRD-272 | L821 · 4. 地图或路线服务异常 | 部分候选计算失败：展示其余可用结果，并对失败部分后台重试； | buildCarpoolMatches；两个 Repository.listIntentPage | 坏密文/坏路线逐条隔离、失败数量可见；无持久受控后台重试 | 部分完成 |
| PRD-273 | L822 · 4. 地图或路线服务异常 | 地图供应商不可用：展示明确故障状态，不使用虚构百分比； | parkCarpoolService.ts；ParkCarpoolDialog.tsx；ConversationBridge | 失败保留、无效路线拒绝；成功后刷新失败明确真实发布结果；合成 Provider 本地测试 | 已实现本地失败行为；真实供应商未实测 |
| PRD-274 | L823 · 4. 地图或路线服务异常 | 已缓存路线超过有效期或地点被修改后必须重新规划。 | parkCarpoolService.performPublish | 内容修改重新规划；仍无独立路线缓存 TTL | 部分完成 |
| PRD-275 | L827 · 5. 邀请与入组边界 | 对同一对象已经存在待处理邀请时，按钮显示“等待确认”； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-276 | L828 · 5. 邀请与入组边界 | 对方拒绝后，短时间内禁止重复邀请，冷却时间由服务端配置； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-277 | L829 · 5. 邀请与入组边界 | 用户在邀请等待期间加入其他同行组时，原邀请自动失效； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-278 | L830 · 5. 邀请与入组边界 | 同行组已满或已关闭时，入组申请自动失效； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-279 | L831 · 5. 邀请与入组边界 | 同一用户不能通过多个账号状态在结果中形成重复卡片； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-280 | L832 · 5. 邀请与入组边界 | 司机或协调人不能单方面读取申请者的精确地址或全部私聊信息。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-281 | L836 · 6. 消息安全 | 仅园区认证用户可以发送同行消息请求； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-282 | L837 · 6. 消息安全 | 对消息请求、邀请和入组申请执行频率限制； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-283 | L838 · 6. 消息安全 | 屏蔽关系双向影响匹配结果和消息入口； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-284 | L839 · 6. 消息安全 | 举报入口保留消息和请求的必要审计记录； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-285 | L840 · 6. 消息安全 | 普通用户不能判断请求是被忽略还是尚未查看； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-286 | L841 · 6. 消息安全 | 用户退出园区或身份失效后，其同行意向立即停止，新的消息入口关闭。 | 两个 Repository.getPrincipal/toIntent | 读写重新验证身份并隐藏失效意向；未持久停止/删除历史及会话授权 | 部分完成 |
| PRD-287 | L845 · 7. 生命周期与数据保留 | 同行意向在计划出发时间窗口结束后自动过期； | parkCarpoolService.ts；ParkCarpoolDialog.tsx | 修改/停止/读时过期过滤通过；缺持久过期任务、通知、屏蔽举报 | 部分完成 |
| PRD-288 | L846 · 7. 生命周期与数据保留 | 过期意向不再参与匹配； | parkCarpoolService.ts；ParkCarpoolDialog.tsx | 修改/停止/读时过期过滤通过；缺持久过期任务、通知、屏蔽举报 | 部分完成 |
| PRD-289 | L847 · 7. 生命周期与数据保留 | 对应待处理邀请和消息请求同步过期； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-290 | L848 · 7. 生命周期与数据保留 | 已接受的一对一会话和同行群聊按新增的拼车助手沟通保留策略处理；可参考 Otto 现有企业私聊保留与删除机制，但不得在未评审跨企业和位置数据的情况下直接继承现有策略； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-291 | L849 · 7. 生命周期与数据保留 | 同行群聊在本次行程结束后进入可归档状态； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-292 | L850 · 7. 生命周期与数据保留 | 精确坐标和路线属于敏感位置数据，应采用最小化保存、访问控制和加密存储；具体保留时长需由安全与合规评审确认。 | 加密 intent payload；加密 publication receipt | 现有字段加密，真实数据库回归；无保留/删除任务，回执也保留位置副本；期限未确认 | 未完成；保留政策待外部确认 |
| PRD-293 | L856 · 8. 通知 | 收到普通消息请求； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-294 | L857 · 8. 通知 | 收到同行邀请； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-295 | L858 · 8. 通知 | 收到入组申请； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-296 | L859 · 8. 通知 | 邀请或申请被接受； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-297 | L860 · 8. 通知 | 同行组成员发生变化； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-298 | L861 · 8. 通知 | 出发时间临近； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-299 | L862 · 8. 通知 | 同行意向即将过期或已经停止。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-300 | L868 · 9. 可用性与无障碍 | 所有主要操作必须支持键盘导航； | ParkCarpoolDialog.tsx；App.tsx | 有未保存退出与状态文本；未完成首错误焦点/完整键盘、真机焦点及 Windows 验收 | 部分实现；无障碍/真机未验收 |
| PRD-301 | L869 · 9. 可用性与无障碍 | 路线重合不能仅依赖颜色区分，应同时提供文字和百分比； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | 只有几何近似解释与统计；无真实路线对比、分岔与地图展示 | 部分完成 |
| PRD-302 | L870 · 9. 可用性与无障碍 | 加载、成功、失败和空状态必须有明确文字； | ParkCarpoolDialog.tsx；App.tsx | 有未保存退出与状态文本；未完成首错误焦点/完整键盘、真机焦点及 Windows 验收 | 部分实现；无障碍/真机未验收 |
| PRD-303 | L871 · 9. 可用性与无障碍 | 操作按钮文案必须区分“发消息”“邀请同行”“加入同行”和“进入同行群聊”； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-304 | L872 · 9. 可用性与无障碍 | 关闭业务面板前，未提交的表单内容应进行离开提醒； | ParkCarpoolDialog.tsx；App.tsx | 有未保存退出与状态文本；未完成首错误焦点/完整键盘、真机焦点及 Windows 验收 | 部分实现；无障碍/真机未验收 |
| PRD-305 | L873 · 9. 可用性与无障碍 | 弹窗关闭后，键盘焦点必须返回到触发弹窗的按钮或合理后继位置； | ParkCarpoolDialog.tsx；App.tsx | 有未保存退出与状态文本；未完成首错误焦点/完整键盘、真机焦点及 Windows 验收 | 部分实现；无障碍/真机未验收 |
| PRD-306 | L874 · 9. 可用性与无障碍 | 动态出现“发现 N 个新同行结果”、请求状态变化或表单错误时，通过可访问的状态区域播报，但不抢占用户当前焦点； | ParkCarpoolDialog.tsx；App.tsx | 有未保存退出与状态文本；未完成首错误焦点/完整键盘、真机焦点及 Windows 验收 | 部分实现；无障碍/真机未验收 |
| PRD-307 | L875 · 9. 可用性与无障碍 | 表单提交失败时，将焦点移到首个错误字段，字段、错误文本和辅助说明必须建立程序化关联； | ParkCarpoolDialog.tsx；App.tsx | 有未保存退出与状态文本；未完成首错误焦点/完整键盘、真机焦点及 Windows 验收 | 部分实现；无障碍/真机未验收 |
| PRD-308 | L876 · 9. 可用性与无障碍 | 地图路线必须有文字摘要，路线区分不得只依赖颜色； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | 只有几何近似解释与统计；无真实路线对比、分岔与地图展示 | 部分完成 |
| PRD-309 | L877 · 9. 可用性与无障碍 | macOS 与 Windows 使用一致的数据与权限逻辑。 | ParkCarpoolDialog.tsx；App.tsx | 有未保存退出与状态文本；未完成首错误焦点/完整键盘、真机焦点及 Windows 验收 | 部分实现；无障碍/真机未验收 |
| PRD-310 | L881 · 10. 核心指标 | 模块打开到意向发布转化率； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-311 | L882 · 10. 核心指标 | 发布后获得至少一个结果的用户比例； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-312 | L883 · 10. 核心指标 | 平均候选数量； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-313 | L884 · 10. 核心指标 | 查看路线率； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-314 | L885 · 10. 核心指标 | 消息请求发送率与接受率； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-315 | L886 · 10. 核心指标 | 同行邀请接受率； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-316 | L887 · 10. 核心指标 | 2 人组及 3—4 人组形成率； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-317 | L888 · 10. 核心指标 | 用户主动停止寻找率； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-318 | L889 · 10. 核心指标 | 屏蔽率和举报率； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-319 | L890 · 10. 核心指标 | 地图服务失败率和路线计算耗时。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-320 | L898 · 11.1 阶段一：发布、个人匹配与消息请求 | 园区认证用户可以从已安装的“园区服务”功能组进入独立面板；无该组的用户可从模块超市添加； | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-321 | L899 · 11.1 阶段一：发布、个人匹配与消息请求 | 一次性预添加不重置用户布局，用户手动移除后不会被再次强制加回； | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | 仅宏创官方组迁移有现有实现与回归；其他园区组预添加未完成，真机未测 | 部分完成 |
| PRD-322 | L900 · 11.1 阶段一：发布、个人匹配与消息请求 | 园区场景默认引导当前园区、园区出口或公共集合点；定位和手动选点作为完整备选； | ParkCarpoolDialog.tsx | 只有手动搜索；缺管理员集合点、定位与选点 | 未完成 |
| PRD-323 | L901 · 11.1 阶段一：发布、个人匹配与消息请求 | 终点支持地点搜索或地图选择，不会被当前定位代替； | ParkCarpoolDialog.tsx；parkCarpoolConversationBridge.ts | 多候选显式选择；对话真实服务契约通过；真实地图及地图选点未完成 | 部分完成 |
| PRD-324 | L902 · 11.1 阶段一：发布、个人匹配与消息请求 | 发布按钮明确表达“发布并查找”，并展示可见范围说明； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-325 | L903 · 11.1 阶段一：发布、个人匹配与消息请求 | 用户必须选择至少一种出行选择，多选时明确说明“本次这几种方式都可以”； | ParkCarpoolDialog.tsx；parkCarpoolDomain.ts | 发布选择与文案已有；domain/组件回归；私家车确认容量尚未实现 | 现有实现；局部回归通过 |
| PRD-326 | L904 · 11.1 阶段一：发布、个人匹配与消息请求 | 同一用户同一天不会产生重复有效意向； | parkCarpoolService.ts；两个 Repository；parkCarpoolContract.integration.test.ts | server-regression.log：真实 SQLite/PostgreSQL 发布、幂等、CAS、停止、确认；desktop-regression.log：真实服务组件契约 | 已实现；本地契约通过 |
| PRD-327 | L905 · 11.1 阶段一：发布、个人匹配与消息请求 | 阶段一结果页展示多个个人候选，并按 `PairOverlap` 排序； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-328 | L906 · 11.1 阶段一：发布、个人匹配与消息请求 | 卡片以当前用户视角显示可执行方案，展示园区身份认证、信息新鲜度、整数化的“约 N%”和“为什么匹配”； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-329 | L907 · 11.1 阶段一：发布、个人匹配与消息请求 | 结果页提供全部、可搭车、可带人和一起叫车的轻量筛选； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | server-regression.log：个人匹配；desktop-regression.log：组件。组匹配/真实地图未完成 | 部分完成 |
| PRD-330 | L908 · 11.1 阶段一：发布、个人匹配与消息请求 | 时间差独立展示，不污染路线重合度；地图路线同时提供文字摘要； | parkCarpoolDomain.ts；ParkCarpoolDialog.tsx | 只有几何近似解释与统计；无真实路线对比、分岔与地图展示 | 部分完成 |
| PRD-331 | L909 · 11.1 阶段一：发布、个人匹配与消息请求 | 陌生用户第一条消息进入“请求”，列表卡在打开前已标明“消息请求”类型； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-332 | L910 · 11.1 阶段一：发布、个人匹配与消息请求 | “我的消息”保留现有筛选行为，新增请求入口不破坏原有会话； | InboxPage.tsx | 原有 Inbox 回归通过；尚未增加拼车请求入口 | 未完成 |
| PRD-333 | L911 · 11.1 阶段一：发布、个人匹配与消息请求 | 用户可以修改、停止或让意向自动过期；信息新鲜度并非只有后端状态，在卡片上有明确反馈； | parkCarpoolService.ts；ParkCarpoolDialog.tsx | 修改/停止/读时过期过滤通过；缺持久过期任务、通知、屏蔽举报 | 部分完成 |
| PRD-334 | L912 · 11.1 阶段一：发布、个人匹配与消息请求 | 存在有效意向时移除模块会提示，移除后仍可通过“我的消息”中的当前同行状态卡停止寻找； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-335 | L913 · 11.1 阶段一：发布、个人匹配与消息请求 | 定位拒绝、地图故障和无结果均有明确状态，候选阶段不暴露精确住址或电话； | parkCarpoolDomain.ts；Service；Dialog | 搜索错误/空结果与候选地址隐藏；定位未实现、地图未真实验收 | 部分完成 |
| PRD-336 | L914 · 11.1 阶段一：发布、个人匹配与消息请求 | 阶段二和阶段三的服务器能力未开启时，不展示无法执行的邀请、加入或群聊按钮。 | ParkCarpoolDialog.tsx | 未增加无法执行的阶段二/三按钮；这不代表后续阶段交付 | 约束保持；后续功能未实现 |
| PRD-337 | L918 · 11.2 阶段二：两人同行 | 发送邀请前必须确定“谁开车”或“一起叫车”，任何方式或司机变更都不得静默发生； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-338 | L919 · 11.2 阶段二：两人同行 | 私家车司机首次确认同行时设置本次可同行乘客数 1 / 2 / 3，不采集车牌、车型或费用； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-339 | L920 · 11.2 阶段二：两人同行 | 请求列表可在未打开详情前识别“同行邀请”； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-340 | L921 · 11.2 阶段二：两人同行 | 接受聊天不会自动组成同行关系；只有接受结构化同行邀请才会形成 2 人关系； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-341 | L922 · 11.2 阶段二：两人同行 | 已入组用户点击“停止寻找”时，明确选择保留当前组或退组并停止，不会发生隐式退组。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-342 | L926 · 11.3 阶段三：多人同行组 | 个人与同行组可进入同一结果列表，已组队成员不会以个人卡重复出现； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-343 | L927 · 11.3 阶段三：多人同行组 | 私家车组以 `DriverOverlap`、最大绕行和剩余容量作为硬条件，不会因与非司机成员高度同路而获得虚高匹配； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-344 | L928 · 11.3 阶段三：多人同行组 | 一起叫车组的 `SharedTaxiGroupOverlap` 同时受最低成员重合度和最大预计绕行门槛限制； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-345 | L929 · 11.3 阶段三：多人同行组 | 卡片显示已确定的同行方式；私家车显示司机和剩余容量，一起叫车显示协调人； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-346 | L930 · 11.3 阶段三：多人同行组 | 司机或协调人处理入组申请，服务端在并发场景下仍阻止超员； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-347 | L931 · 11.3 阶段三：多人同行组 | 司机或协调人退出时只能显式转交，无人接受时小组关闭新申请，不会自动指定最早加入者； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-348 | L932 · 11.3 阶段三：多人同行组 | 入组通过后成员人数正确增加，新成员不能读取加入前的群聊历史； | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-349 | L933 · 11.3 阶段三：多人同行组 | 请求列表可在未打开详情前识别“入组申请”。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-350 | L939 · 12. 上线前必须确认 | 高德或最终地图供应商是否允许路线缓存、路线重合度等衍生计算； | AMap Provider；design-decisions.md | 缺已授权真实测试凭据、地图供应商缓存/衍生计算许可证明；无真实供应商验收 | 外部条件未满足；相关完整代码亦未完成 |
| PRD-351 | L940 · 12. 上线前必须确认 | 精确位置数据的存储、加密、删除和审计策略； | 加密 intent payload；加密 publication receipt | 现有字段加密，真实数据库回归；无保留/删除任务，回执也保留位置副本；期限未确认 | 未完成；保留政策待外部确认 |
| PRD-352 | L941 · 12. 上线前必须确认 | 阶段三一起叫车组的默认人数上限是否最终定为 4 人； | design-decisions.md | PRD 默认/工程假设有记录；需产品、安全及举报运营负责人确认；相关功能尚未完成 | 外部确认待办；不能替代内部实现 |
| PRD-353 | L942 · 12. 上线前必须确认 | 私家车司机可选乘客容量是否保持 1 / 2 / 3； | design-decisions.md | PRD 默认/工程假设有记录；需产品、安全及举报运营负责人确认；相关功能尚未完成 | 外部确认待办；不能替代内部实现 |
| PRD-354 | L943 · 12. 上线前必须确认 | 私家车与一起叫车各自的最低路线重合度、最低成员重合度与最大预计绕行阈值； | design-decisions.md | PRD 默认/工程假设有记录；需产品、安全及举报运营负责人确认；相关功能尚未完成 | 外部确认待办；不能替代内部实现 |
| PRD-355 | L944 · 12. 上线前必须确认 | 默认时间窗口是否采用前后 30 分钟； | design-decisions.md | PRD 默认/工程假设有记录；需产品、安全及举报运营负责人确认；相关功能尚未完成 | 外部确认待办；不能替代内部实现 |
| PRD-356 | L945 · 12. 上线前必须确认 | 用户举报后的人工处理流程与责任人； | design-decisions.md | PRD 默认/工程假设有记录；需产品、安全及举报运营负责人确认；相关功能尚未完成 | 外部确认待办；不能替代内部实现 |
| PRD-357 | L946 · 12. 上线前必须确认 | 园区、企业和账号身份失效后的数据处置流程。 | design-decisions.md | PRD 默认/工程假设有记录；需产品、安全及举报运营负责人确认；相关功能尚未完成 | 外部确认待办；不能替代内部实现 |
| PRD-358 | L952 · 13. 与现有 Otto 的兼容性验收 | 原有园区公告、满意度调查、装修、停车、网络固话、会议室、电卡、报修、车辆访客、企业星链图、待办和我的申请的激活链路全部保持不变。 | 原有 Inbox、enterprise-mls、mlsTransportRepository、otto-native/src/mls.rs | server/desktop/native-regression.log：选定原有回归通过；未覆盖全部真机/联邦链路 | 兼容性局部回归通过；新沟通能力未实现 |
| PRD-359 | L953 · 13. 与现有 Otto 的兼容性验收 | 打开“拼车助手”不会创建新聊天会话，不会改变当前 Agent，不会同时叠加两个业务弹窗。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-360 | L954 · 13. 与现有 Otto 的兼容性验收 | 右栏 `panel` 形态与完整工作区 `page` 形态均能激活同一个同行模块，且折叠右栏不会中断已打开的业务流程。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-361 | L955 · 13. 与现有 Otto 的兼容性验收 | 模块组包升级不得清空用户的其他功能组、模块顺序或自定义布局；从右栏移除入口不得删除同行数据。 | moduleCatalog.ts；moduleWorkspace.ts；moduleModal.ts；App.tsx | desktop-regression.log：原有布局/激活回归；真机完整入口流程未实测 | 现有实现；局部回归通过 |
| PRD-362 | L956 · 13. 与现有 Otto 的兼容性验收 | 个人版、无 `park_service`、无 `park_carpool_v1`、无园区绑定、园区跨租户和账号停用场景都必须 fail-closed，不得因前端缓存而越权。 | parkCarpoolService.ts；SQLite/PostgreSQL Principal 适配 | 已测试禁用、未绑定、跨园区与伪造 accountId；消息授权未实现 | 部分完成 |
| PRD-363 | L957 · 13. 与现有 Otto 的兼容性验收 | 现有同企业 1:1 私聊、未读数、附件、E2EE/MLS 设备注册和联邦联系人功能通过原有回归测试。 | 原有 Inbox、enterprise-mls、mlsTransportRepository、otto-native/src/mls.rs | server/desktop/native-regression.log：选定原有回归通过；未覆盖全部真机/联邦链路 | 兼容性局部回归通过；新沟通能力未实现 |
| PRD-364 | L958 · 13. 与现有 Otto 的兼容性验收 | 同行跨企业联系只能由有效匹配或邀请关系触发，不得变成可搜索整个园区成员的通讯录。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-365 | L959 · 13. 与现有 Otto 的兼容性验收 | 地理位置授权只新增对受信任主窗口的 `geolocation` 处理，不放宽摄像头、视频、外部页面或任意第三方脚本权限。 | 无完整实现入口/持久状态 | 未执行该功能完整流程；不得以已有发布或私聊测试抵充 | 未实现 |
| PRD-366 | L960 · 13. 与现有 Otto 的兼容性验收 | 拼车助手的 Schema 迁移、数据删除、账号退出园区、组员并发加入和群成员离开均有服务端测试。 | parkCarpoolSchema.ts；数据库契约 | 迁移、版本并发、事务回滚已测；删除、退出园区处置、组并发/成员离开未实现 | 部分完成 |
| PRD-367 | L961 · 13. 与现有 Otto 的兼容性验收 | 所有地图供应商失败、限流和超时场景不会拖垮 Otto 服务器，不会向用户显示虚构路线百分比。 | MapProvider；parkCarpoolService | 无效/规划失败行为已测；真实供应商限流/超时及容量压测未验证 | 部分完成；未实测外部链路 |

## 执行证据与解释

代码目录：服务端 `packages/server/src/modules/park_carpool/`，桌面 `packages/desktop/src/renderer/`；表中日志保存在本目录 `evidence/`。完整命令、测试替身边界与失败门禁见 `final-self-review.md`。表内“本地通过”不是实际地图、真实账号、真机或三个阶段端到端验收通过。

## 原文表格/公式与任务提示词补充规则

| 编号 | 阶段/规则 | 实现与验收场景 | 证据 | 结论 |
|---|---|---|---|---|
| ADD-01 | 一：PairOverlap=2C/(L1+L2)，同方向共同区间去重 | 区间投影/裁切、上界；短绕行形状简化 | server-regression；sampling-red/green | 合成几何通过；未真实路网验收 |
| ADD-02 | 一：出行兼容矩阵，时间窗口相交 | 司机/乘客双向与叫车；两人时间窗口 | domain tests | 本地通过；共同时间段 UI 仍未完整展示 |
| ADD-03 | 一：北京时间同日、无效日、跨午夜 | 输入规范化及规划前后复核 | service/domain tests | 本地通过 |
| ADD-04 | 一：下午3点、前后20分钟、多地点、取消、修改、重复确认 | 对话桥接、公用服务、加密数据库与 vault 草稿 | desktop-regression | 本地契约通过；重启真机未实测 |
| ADD-05 | 一：页面和对话去除北京默认 | 两个搜索入口不传硬编码城市 | conversation tests、代码自查 | 已修改；真实城市搜索未实测 |
| ADD-06 | 一：发布幂等、规划中停用/迁园/修改/停止、旧表单版本 | journal、CAS、重新授权；回执故障注入原子回滚 | SQLite/PostgreSQL contract；UI contract | 本地通过；未多进程压测 |
| ADD-07 | 一：写入成功后刷新失败 | 显示已发布，保留真实回执；更新独立表单版本 | Dialog tests、UI contract | 本地通过 |
| ADD-08 | 一：分页召回不可提前漏掉好结果 | 两数据库 keyset；遍历后筛选 | repository tests | 消除固定截断；全园区计算/内存尚无全局预算 |
| ADD-09 | 一：离线站内消息、可靠通知、已读、重试、数据删除 | 无拼车持久事件/outbox/清理 | 未执行 | 未实现 |
| ADD-10 | 二：原子邀请接受、拒绝/撤回/过期/冷却、两人成组、停止分流 | 无可用状态机/入口 | 未执行 | 未实现 |
| ADD-11 | 三：DriverOverlap及绕行/容量、Taxi=75%平均+25%最低及阈值 | 无候选相关组匹配 | 未执行 | 未实现 |
| ADD-12 | 三：同人单组、最后名额并发、显式转交、归档 | 无完整组事务/成员状态机 | 未执行 | 未实现 |
| ADD-13 | 一/三：独立园区沟通授权，MLS成员加入/移除/历史 | 保持原私聊同企业限制；没有扩展园区/多人协议 | 原有 native 18 项仅回归 | 新能力未实现 |
| ADD-14 | 二/三：双方真实能力协商 | 未公布 groups 等新能力 | 静态自查 | 未实现；关闭不是交付 |
| ADD-15 | 全部：完整 UI 用户旅程 | 发布→结果→路线→请求→聊天→邀请→入组退组 | 仅发布/修改/停止有本地真实服务组件契约 | 全链路未完成、未执行 |
| ADD-16 | 工程：保留用户工作/不部署生产 | 原始 dirty 清单记录；无 reset/push/deploy | implementation-log | 遵守 |
| ADD-17 | 工程：doctor/边界/typecheck/lint/build/code-map | 见最终报告真实结果 | evidence | doctor、仓库边界未全绿 |
