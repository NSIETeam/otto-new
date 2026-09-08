# 园区跳蚤市场技术决策

状态：开发中，生产能力未开放。以下早期决策保留历史；当前状态以 11:09 更新节和自查报告为准。产品基线为 PRD v1.1。

1. 在原工作区精确新增模块。HEAD 为 93dcf8ea2dd0e9582589351a6e126ecd24b33b86，internal 分支；只从 HEAD 建 worktree 会漏掉未提交拼车实现，因此不采用该方式。初始文件摘要见 ../research/flea-market-evidence/baseline.json。不得 reset/stash/clean/pull。
2. 市场属于 park_services/flea_market，消息属于 collaboration，图片使用 data_platform 加密对象底座。既有 directMessageRepository 的 getActiveAccountInOrganization 校验原样保留；企业普通管理员不自动成为市场管理员。
3. 消息：企业客户端 supportsMlsPrivateMessages 及服务器公布的 e2ee_mls_transport_v1 表明必须支持 MLS，不能改为明文市场聊天。选择显式园区账号对 grant 的受控会话适配，客户端生成受保护载荷；请求、载荷、商品授权、额度、outbox 在同一数据库事务提交。原企业私聊接口不扩大权限。部署实际启用模式仍需运行验证；MLS 桥未完成前不宣告市场能力。
4. 图片：选择服务端 libheif WASM 解码 HEIC/HEIF，加 sharp 修正方向、去元数据、缩放 JPEG；需真实样本与双端验收后确认能力。每次图片请求经身份及资源状态网关，Cache-Control: private, no-store，不返回裸公开或预签名读地址。独立草稿租约及治理证据引用。当前依赖未安装、解码未验收，不宣称支持。
5. 存储：共用异步事务 Repository，SQLite BEGIN IMMEDIATE，PostgreSQL 事务锁及唯一约束；索引列承担园区/状态/价格/时限查询，敏感扩展载荷加密。迁移使用 schema contributor 和追加 PG 迁移。业务与 outbox 同事务，worker 随单机及集群生命周期启动停止，以数据库租约和事件唯一键恢复重启。未完成装配前不对外开放。
6. 本人记录独立于园区开关，从个人中心可达；停用账号拒绝，退出园区仅本人历史文本、允许删除及申诉。图片立即撤权。连续结束 180 天清理内容，结束状态互转不重置；最小记录及备份最终保留期限未获运营确认，列为上线条件，不默认永久保留。
7. 测试：专用临时目录 otto-flea-market-*；园区 P/Q、企业 E1/E2/E3，seller/buyer/stranger/outsider/disabled/market-admin/company-admin。真实 PostgreSQL 使用 /opt/homebrew/opt/postgresql@17/bin，通过独立 Unix socket 临时集群运行，绝不连接用户业务库。覆盖服务重启、版本竞态、事务回滚、时区额度。Windows、真实桌面验收未运行。

环境：macOS，Node v24.4.0，npm 11.5.2。doctor 原有源码容量 61.13 MB 超 50 MB，其他检查通过；不提高预算隐藏失败。基线 git diff --check 通过。

## 执行中核实与修正

- PostgreSQL 真实企业业务迁移入口是 `packages/server/src/enterprise/postgresMigrations.ts`，并非 data_platform 同名控制表文件。市场迁移当前为 **16**；并行拼车代码已占用 15，已增加重复编号回归测试。完整企业迁移在独立临时 PG 集群执行两次成功。
- 当前仓库 `enterprise/e2eeProductionReleasePolicy.ts` 为 `enabled:false`；客户端只有协商得到 `e2ee_mls_v1` 才激活正式 MLS 模式，并拒绝协议降级。源码支持某模式不代表实际服务器运行该模式。完整跨企业安全消息适配尚未开发，不使用明文或模拟成功绕过。
- 图片依赖实际安装并锁定 `sharp@0.35.4`、`heic-decode@2.1.0`（libheif WASM）。处理在限 15 秒的 Worker 中运行，输入 20 MB、解码像素 4000 万，详情最长 2400/缩略图 640；已有真实合成 HEIC/PNG/WebP/JPEG 测试。Windows/安装包和 GPS HEIC 待验收。依据：[sharp constructor](https://sharp.pixelplumbing.com/api-constructor/)、[libheif-js](https://github.com/catdad-experiments/libheif-js/blob/master/README.md)。
- 初始 PostgreSQL 使用数据库全局互斥行，SQLite 用 BEGIN IMMEDIATE；索引承担价格/状态/园区/时间查询。文本保持加密后在受授权服务中匹配，性能未压测，下一步必须改进扫描与事务粒度；不宣称容量达标。
- 商品历史和幂等结果也包含内容副本，180 天清理同时擦除这些副本的描述/图片引用/交接/私有备注。治理独立证据结案后设置单独 180 天期限；法律保全和最终最小记录期限仍未落实。
- 跳蚤市场 schema 已装配；Service/Attachments/Jobs 尚未绑定生产身份/配置/HTTP/服务器启停，不能当作完整接入。未新增能力标识和生产开关，不存在已开放的入口。
- 既有附件底座使用真实 EncryptedObjectStore；当前图片服务的 400 个可用附件限制仅为初始资源保护，尚未复用完整存储字节额度/对象迁移机制。需补齐 Task 6，不能标完整。

## 2026-09-08 11:09 接续实现更新

- HTTP、IPC、桌面页面、主进程草稿与通知、SQLite/PG 生产身份适配、单机/集群任务启停均已装配；早期“尚无接入”的描述不再代表当前代码。
- 当前追加迁移 16–22：基础、治理、管理员、咨询、消息序列、原生 MLS、本人记录隐藏；没有重写已有迁移。
- 原生 MLS 由 @otto/native ParkMlsNativeKernel 执行；外层设备签名使用独立域 otto:park-market-mls:v1，当前批准设备名册必须完全一致。服务器只存密文及许可元数据，首次问题与业务状态同事务提交。SQLite/PG × 信封/原生 MLS 四组真实流程通过；多设备恢复和历史保留仍需完善。
- 消息举报只接受最多 10 条真实参与会话中的所选消息，明文属于用户主动披露，标记 reporter-provided；同时冻结原始已存密文。不会赋予管理员读取整段私人会话的能力。
- 发布原子解除使用图片的草稿引用；被移除图片不允许通过草稿租约绕过撤权。结案申诉证据和原始申诉审计描述均纳入 180 天清理。法律保全仍待集成。
- 内部分享使用 otto://market/商品ID?server=地址，排除凭证/query/hash，不自动切换服务器或账户；详情继续真实服务端鉴权。
- 消息默认加载最新 200 条并按序列向前翻页；已读限定已显示序列，迟到 outbox 通知继承已读回执。
- 园区管理方具备显式授权入口，普通企业管理员不能自动治理；已退出园区的被授权账号仍可撤销角色。
- 保持 ready=false，因为完整 PRD、平台和安全/保留条件尚未完成，不能把已写代码等同生产开放。


## 2026-09-08 12:33 指定分支目录迁移及继续修复

重新检查发现 `codex/blue-heron-7f3a9c` 已位于 `/Users/yang/Desktop/otto-carpool-fixed-91bc4e`，HEAD 为拼车提交 `7c4d016f`。在该干净工作区基于三方合并迁入 206 个市场相关文件，未覆盖拼车提交；补迁 Git 忽略的共享 `park-market.d.ts`，后续提交必须显式包含该类型源文件。备份 `/tmp/otto-market-transfer-verified`。

本轮修复并发密文待重试记录覆盖、关联商品跨消息页遗漏、超量选图整批拒绝、同账号跨服务器表单残留；恢复逻辑拒绝无 MLS 代际并限制恢复按钮。真实企业登录/两库两种加密 5 项，服务 142 项，以及新增回归均有日志。当前环境 doctor 通过，边界失败为既有政策测试跨层导入。详细证据与未完成范围见更新后的自查报告及缺陷台账。尚未提交或推送。


## 2026-09-08：同部署已有会话与联邦边界核对

`packages/server/src/modules/federation_gateway/federationRepository.ts` 创建联系人明确拒绝 local deployment，要求本地账号使用组织目录。园区市场主体是同部署跨企业账号，不能凭园区成员资格构造 remote principal 或扩大联邦授权。已有同企业私聊经既有权限检查复用；跨企业已存在的市场会话按园区账号对复用，不创建重复会话。执行计划 Task 22 要求“正常会话只开放现有已验证附件”，故保留既有私聊附件能力，新市场跨企业会话在其附件协议尚无验证前不显示上传入口。该限制须在平台整体验收报告明确。

目标分支当前目录为 `/Users/yang/Desktop/otto-carpool-fixed-91bc4e`，基线 `1fca182e`；再次迁移保留拼车修复并通过其启动、聊天及工作区回归。所有动作仅本地，未推送。
