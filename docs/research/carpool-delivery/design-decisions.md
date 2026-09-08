# 拼车设计、数据与接口决策

最终源码目录 `/Users/yang/Desktop/otto-carpool-verified-7f3a9c`，分支 `codex/blue-heron-7f3a9c`。三个阶段共用真实服务、身份授权与数据库；本文件取代早期“仅基础纠错”的记录。生产许可、发布门禁和未实测项目见最终自查报告。

## 模型与状态

- `park_carpool_intents` 保存当日意向，精确地点、路线采用既有字段加密/AAD。个人状态 `active / paused / expired`；`grouped` 从有效组成员关系推导，不建立第二个意向状态源。版本 CAS 保护编辑/停止；园区和企业均由认证账号推导。
- SQLite 增加 `version`、加密的 `park_carpool_publications` 和 `park_carpool_workflow`。PostgreSQL 使用既有 `enterprise_business_records` 保存意向/发布回执，migration 15 `park-carpool-workflow-authority` 增加 workflow 表。工作流按园区加密保存，事务锁定园区聚合，SQLite/PG 使用相同业务状态机；不会写入工单或企业内私聊表。
- 发布：30 秒租约 pending → 同事务保存意向及成功 receipt。相同键、相同内容重放；换内容拒绝。规划后重新检查身份、日期和版本；回执失败回滚；旧请求不能复活已停止/删除的意向。旧客户端省略幂等键时服务端生成内部键，但旧表单不具备新客户端的 expectedVersion 保护。
- 请求：`text / carpool_invite / group_join / group_invite`；持久保存双方意向绑定、语义 fingerprint、首条消息、摘要、方式/司机、状态及到期时间。pending 可接受/忽略/拒绝/撤回/屏蔽/失效；忽略只对接收者可见。请求修改/停止、入别组或组版本变化会使旧请求失效；接受聊天与成组是不同动作。
- 同行组：2–4 人、明确方式、唯一司机或协调人、司机乘客容量 1/2/3。人数和角色由成员列表及 role owner 推导；pending 不计名额。事务内保护最后名额、单用户单组、重复接受。角色转交需提出且接任者接受；司机重新确认容量。无人接任时关闭新申请；只剩一人则关闭组并恢复剩余者个人寻找资格。
- 群会话：独立 `direct / group`，每次成员/设备变化产生 generation；generation 的成员集合、createdAt/retiredAt 构成加入、离开和历史可见边界。两人关系立即新建组会话，且绝不复制私聊历史。阶段三关闭不会隐藏已授权的两人及历史群会话。
- 对本人仍有效的同行组提供独立路线预览授权；不要求本人再次成为公开匹配候选。停止接收新匹配而保留组时，仍可查看本组路线及聊天。

## 地图、匹配与位置保护

- 生产 Provider 是高德 Web Service：地点检索、驾车规划、逆地理编码/GPS 转换、服务端静态图。密钥只从服务端环境读取；不把第三方脚本引入 renderer，不放宽 CSP。静态图数据有体积与超时限制。
- 有向线段投影、邻近区间裁切及并集计算共同距离 C，保证 C 不超过较短路线；`PairOverlap=2C/(L1+L2)`。40 米邻近带、15 度方向差及 0.5 米形状简化是工程近似参数，不是客户认可的道路准确率；保留折返，最多 2,048 个简化点，超限拒绝。相邻道路、立交和道路层级无法仅凭几何完全区分，页面明确说明这一限制。
- 私家车组以候选人与司机重合度、rider 选择、剩余容量和预计绕行为硬条件。叫车组使用 `0.75×平均+0.25×最低`，最低成员重合及最大绕行均受门槛限制。绕行使用 Provider 规划的上下车顺序和各段耗时，不用直线距离冒充行车时间。每个外部候选单独计算，并在 await 后再次核验组、意向、屏蔽及 availability。
- 双方/全组时间窗取交集，显示共同出发时段；时间差独立显示。百分比取约整数，排序依次考虑新鲜度降级、同路程度、时间差、共同里程和稳定 ID。
- 两库个人召回每页 200 个，完整筛选后只保留当前结果页 50 个；游标绑定排序/筛选/内容摘要，过期游标要求刷新。组匹配按 25 个规划快照批次推进、逐项送入同一有界排序器，不因前段候选不合适而截断后段。授权聚合仍按园区载入，超大园区的内存、延迟和地图成本需要负载验收，不能据 205 候选测试宣称无限扩展。
- 私人地点不通过删数字正则伪装安全，候选只显示服务端解析的公共区域或隐藏标签。公开/本组路线都隐藏所有人的端点周围至少 1 公里，再粗化并转成不含经纬度的示意坐标；深色实线表示全员共同、浅色虚线表示部分共同、灰色表示单独路段，配文字与分岔标记。短路线在隐私范围内不显示图形。
- 路线有效性绑定本次意向/出发窗口，修改地点重新规划；不把跨日旧路线当作新的发布结果。尚无真实供应商缓存/衍生计算许可结论。

## 独立园区加密通信

- 新增 Native `ParkMlsKernel`，不修改原 MLS 二人同企业校验。每个独立园区会话代次授权 2–4 个账号、最多 100 台获批设备；设备 credential、服务器 scope、成员集合、会话/代次和事件 ID 均绑定并验证。
- HTTP `/transport` 必须同时具备认证会话、获批设备和 Ed25519 设备签名。签名绑定 `otto:park-carpool-device:v1`、账号、60 秒时间窗和完整命令，拒绝缺签名、篡改或过期证明。内部 unsigned 函数仅供可信服务组合，未暴露为 HTTP 旁路。
- Native 使用 OpenMLS，服务器只转发 ciphertext/Welcome/KeyPackage；保存或还原失败停止收发，没有明文降级。Main 通过现有 OS safeStorage 保护本机持久状态。消息先加密持久化后投递，以不可变事件 ID 重试；未知/损坏密文逐条隔离。
- 入组前及离开后的消息受服务器代次授权和真实 Native 密钥共同限制；新成员没有旧组密钥。私聊、两人群与多人群是不同会话。原生已过期 KeyPackage 不会因离线很久后重连而再次变成可发布密钥；仅在确认没有待处理 Welcome 使用它时清理私钥。
- 聊天展示已授权会话成员的脱敏名称/编号及角色。可屏蔽同代共同成员；仍在共同组中时须显式确认退出，随后轮换密钥。消息举报仅允许本人有权读取的代次事件；用户明确同意后主动提交该条明文，标记为“举报人提交，待核实”，不是服务器声称能解密/鉴定原文。管理员只能在授权处理入口看到最小证据并记录处理者、时间及说明。
- Native 每设备限制 100 个 KeyPackage、1,000 个会话代次、5,000 条缓存消息；保留清理会删除不再允许保留的会话/密钥。达到上限时明确失败，不默默丢历史；高频极端使用及长期离线压力尚未验收。

## 生命周期、通知与指标

- 标准/集群服务器均注册 60 秒维护任务；集群用共享租约避免同一轮重复执行，租约释放异常也释放本地运行状态。过期、身份失效、停止、退组在服务端生效。
- 新匹配、请求处理、成员变化、确认寻找、临近出发、停止/过期等写入幂等站内事实；Main 15 秒轮询、聊天 5 秒轮询。后台先显示新结果数量，由用户刷新，不突然重排。
- 站内记录可在退出 App 后保留；App 完全退出时不会产生本机 OS 通知。已读、重连和发送重试持久化；本机密钥恢复明确提示不可恢复的旧明文。
- 工程默认：到期后 24 小时清理精确位置及发布回执；沟通记录保留 30 天。用户可删除同行数据，旧代次成员及本机状态清理；被别人屏蔽的关系不会因本人删数据而绕过。迁园区只清理旧园区事实，不误删新园区有效意向。
- 管理员可见真实业务计数和按北京时间用户日聚合的打开→发布转化、匹配比例、候选均值、路线查看、请求/邀请接受、两人/多人关系、停止/屏蔽/举报、地图操作和组规划批次失败率/耗时。统计不保存路线坐标，随保留期/用户删除清理。后台查询也计入候选样本；这是运营观测口径，不应误称严格漏斗归因或真实商业转化。

## API、开关与兼容

统一前缀 `/enterprise/park-carpool`：GET 根状态、GET `/places`、GET `/matches`（cursor/filter）、PUT `/intents`、POST `/intents/stop`、POST `/intents/confirm`、POST `/reverse`、POST `/map`、POST `/route-preview`、GET/POST `/workflow`、POST `/transport`、DELETE `/data`。具体请求类型见 `parkCarpoolHttp.ts` 与 public TypeScript 导出。

能力：基础 `park_carpool_v1`；请求 `park_carpool_requests_v1`、加密 `park_carpool_mls_v1`；两人邀请 `park_carpool_invitations_v1`；多人 `park_carpool_groups_v1`。后续能力要求请求及上游能力同时开启。关闭新功能不删除数据、取消明确授权的保留历史，也不等于功能已验收。

桌面仍使用唯一 `park-carpool` 模块、统一 `ModuleModalState`、原 `InboxPage` 壳和现有通知服务。移除入口读取服务器当前业务状态，有有效意向/组才提示；失败时保守提示。页面、对话使用同一服务契约，草稿按企业/账号在加密 vault 保存。macOS 用途说明已加入；Electron 位置 grant 只由主窗口显式点击触发、15 秒有效、仅主 frame；视频及其他权限不放宽。Windows 非 MSIX 打包未虚构额外 manifest 权限声明，仍需 Windows 真机验收。

## 配置（均为工程默认，需运营/安全确认）

| 环境变量 | 默认 |
|---|---|
| `OTTO_PARK_CARPOOL_REQUESTS_ENABLED` / `INVITATIONS_ENABLED` / `GROUPS_ENABLED`（后两项同样带 `OTTO_PARK_CARPOOL_` 前缀） | true |
| `OTTO_PARK_CARPOOL_STALE_MINUTES` / `PAUSE_MINUTES` | 120 / 360 |
| `OTTO_PARK_CARPOOL_POSITION_RETENTION_HOURS` | 24 |
| `OTTO_PARK_CARPOOL_COMMUNICATION_RETENTION_DAYS` | 30 |
| `OTTO_PARK_CARPOOL_DRIVER_MINIMUM_OVERLAP` / `TAXI_MINIMUM_OVERLAP` | 0.35 / 0.35 |
| `OTTO_PARK_CARPOOL_MAXIMUM_DETOUR_SECONDS` | 600 |
| `OTTO_PARK_CARPOOL_REQUEST_LIMIT_PER_HOUR` / `COOLDOWN_MINUTES` | 10 / 30 |
| `OTTO_PARK_CARPOOL_MAX_TAXI_MEMBERS` | 4（允许 2–4 整数） |

地图密钥及基础重合阈值沿用既有启动配置；无效开关、数值范围或容量配置直接报错。不得把默认 true 当成生产批准；实际发布需按部署门禁显式配置。
