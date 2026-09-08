# 1.9.15 发布执行记录（尚未发布）

## 本次明确授权的例外

- Windows 无 Authenticode，macOS 无 Developer ID/公证；通过显式 `unsigned_desktop_stable` 发布，不跳过运行时、安装、包完整性或企业 Ed25519 签名检查。操作系统可能要求用户确认，不能保证所有旧客户端无交互自动安装。
- 旧仓库管理员核验由用户取消。通过显式 `allow_unverified_legacy_mutability` 记录状态 `unknown`，而非伪造通过；保持资产/tag 不覆盖、latest 指针核对和补偿、服务器回滚前置条件。GitHub.com 目前允许不可变 Release 改 latest/prerelease，但资产和 tag 不可修改：[官方说明](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)。
- 用户明确授权本次单人应急批准。这不等于独立双人审核；生产环境限 `internal`、禁止管理员绕过，审批人仍须在 GitHub 留下本次批准记录。发布结束后恢复禁止自审。
- 用户明确授权临时使用当前本机 GitHub 登录令牌，在 `production-automation` 的 `OTTO_LEGACY_RELEASES_TOKEN` / `OTTO_CANONICAL_ADMIN_READ_TOKEN` 中加密保存。仅在来源冻结、准备执行时注入；所有发布、补偿与状态核对结束后立即删除，并重新列举名称验证已不存在。当前尚未注入。

## 企业网关与密钥（已实施）

- 旧企业包私钥在原目录、源码紧急备份及生产恢复包中未找到。经用户授权轮换，新的包签名 key ID 为 `5eccf600b381c3aa`；私钥和两把不同的 CI SSH 私钥由 Windows DPAPI CurrentUser 加密托管，未写入源码。
- 旧企业包公钥保留。企业许可证签名/信任链未轮换，不与部署包密钥混用。
- 管理员通道使用现有受信 SSH 主机密钥；网关源自锁定提交 `c8ef4a32930e86c2f8d53ddc43c255f283d3b134`。在 root-only 目录验证独立钉住的 payload/public-key SHA-256 与 Ed25519 签名后安装，不由 CI 自行设置信任根。
- 安装 v5 网关和不同 UID/GID、无附加组的 `otto-ci-deploy` / `otto-ci-rollback`。sudo 仅允许固定网关，SSH 禁用转发及 PTY。真实 SSH 预检与对方角色操作的拒绝测试均通过。
- 网关 SHA-256：`7879001db0e8fde08874d49444a11190067c7b0e5a5973031fef7862b9c3a758`。
- 镜像发布 helper：`4e2ecf9db8f031093c30d837f28c444cf235832d82b3e2712d405b27a9c05099`。
- 镜像回滚 helper：`24f2ed9983878aa134401821b725a772ada837ca855e7b95c9f0de2c71df7fc4`。
- Bootstrap 发现 umask 将账号父目录 0711 收紧为 0700，造成 SSH 无法穿越；仅将该 root-owned 目录修正为 0711，未改变 sshd 认证规则。之后真实 SSH 双角色测试通过。
- 本次网关操作未改变企业配置、current release、数据库，也未重启业务。
- 用户随后明确授权将企业包签名私钥及两把专用 SSH 私钥写入指定 GitHub 加密环境；已完成，未打印/提交密钥，许可证公钥仍继承原有配置。个人 OAuth 尚未注入。
- 实测旧回滚工具无法解析现有 `OTTO_BACKUP_ENCRYPTION_KEY_FILE`。对旧 `common.sh` 核验原 SHA-256、root-only 备份后，仅增加该键和 `OTTO_ENTERPRISE_DEPLOYMENT_GRANTS` 白名单；完整现有配置解析通过，业务未重启。修改后 SHA-256：`800d63c15f65fbe7cd52afeace4706eb669ae84af03df62d1a063fe564005b4a`。

## 当前服务与证据边界

- 线上仍为 1.9.14，build `8dbd341cb53adc0659708c9dc1b53ce0359e71ed`，数据库 schema 24。候选目标 schema 26，必须做真实隔离副本迁移和核对，不能视为无迁移更新。
- 最近服务备份成功，无容量告警；异地副本未配置，不能宣称已具备完整异地容灾。升级前另做新备份和受限本机恢复副本。
- 新备份于 `2026-09-08T18:09:19.453Z` 完成；schema 24，备份 SHA-256 `9353edfcda5635bb10c865d60f7c51e5c71db5e3df15c05c65e01783ad8d9f50`。备份与恢复所需密钥/配置已经受信 SSH 导出到受限本机目录，未进入仓库。恢复包 73,302,847 bytes，服务器与本机 SHA-256 一致：`cf0d748fb6452e4bdc344f4f091f01d0341a049bd477644bad5084220568d749`。这是恢复资产保全，不是已经做过恢复演练。
- 随后以旧版真实备份 CLI 在隔离目录完成该备份的解密、数据库与附件完整性验证：`verified=true`、schema 24、13 个文件、7 个附件对象，5.91 秒，子进程峰值 RSS 92,588 KiB。未重启服务、未写生产数据库；这仍不等于已完成恢复后启动及业务验收。
- 已通过授权管理接口确认现有许可证 `active`、`enforce=true`；包签名轮换没有改变现有许可证签名 ID。新版本仍须在隔离副本上验证原公钥链与七功能授权。
- 固定、断网、限 512 MiB/2 CPU 的 Linux 容器网关集成检查通过：包括签名篡改、同 UID/GID、额外 sudo 权限、角色越权、重复发布、锁、镜像回滚和失败恢复。
- 桌面平台签名与企业部署包签名是两种独立能力。前者按授权豁免，后者始终必需。
- 测试通过不代表已经发布或完成真实用户升级。安装包、CI 全量验证、canary、双仓与镜像最终状态均需后续追加实际回执。
- 发布前只读完整性核对发现历史手工热修沿用了原 1.9.14 manifest：运行 build 为 `8dbd341c`，原清单 build 为 `675813a4`；7654 个登记文件中有 5 个变化、2 个额外文件。已经定位七功能补丁和组织授权补丁的来源并核对产物哈希，仍需建立真实、可审计的恢复基线后才能执行线上切换。不会通过修改原 manifest 假装它仍是未经修改的原包，也不会放宽新包验签/回滚检查。
- PR #59 首次候选 `772feaba` 的干净 macOS CI 暴露 13 项真实任务评测失败，不能以 Windows 源码别名环境的 130 项通过替代。定位为 macOS 临时目录 `/var` 与 `/private/var` 的根路径别名被误判越界；修复必须同时保留工作区内部链接、跨工作区、硬链接及根目录替换的拒绝行为。该候选的五平台 SQLCipher 构建和矩阵校验通过；PR 非特权构建的签名证明步骤按设计未执行，不等于发布流水线的正式证明。

## 后续发布前实测（仍未发布）

- 候选 `c93ce76a2a2b40cbc36b42a8f957cb21bb9f4185` 的本地真实 junction 临时目录回归 131/131 通过；远端干净 macOS Node 22 CI `34268456090` 的确定性 Agent 评测也已通过，关闭前述 13 项路径别名失败。该 run 随后的 recurring-task 静态检查发现未受管定时器及同名 React setter，尚需修复，不能标记整条 CI 通过。五平台 SQLCipher run `34268455896` 成功，PR attestation 仍按非特权边界跳过。
- 已将原始签名 1.9.14 包和两组历史热修重建为独立可追溯检查点；独立源码分支 `rollback/1.9.14-verified-seven-feature-checkpoint` 为 `304d05969cad7d366e2238490ab4c168e127a560`。新检查点 build 为 `1376fba9d2f1eac0a6f50825c2ca001c691c253c`，source-input 为 `4422b42b2c8c80738a05aa3ba43a157808c8e3de09c26f80b29c0d138af2247e`。完整 7664 文件及来源核对通过，归档与外部接受记录分别用新企业包密钥签名。归档 SHA-256 为 `01101791b2e154086966e6d641b6e395a6a4259f25321a1f30f899aeaa103d7b`。原始归档、旧 manifest 和旧部署目录均保留不修改；新检查点尚未激活。
- 隔离演练在真正启动前查出旧 Node 解包继承官方归档 UID/GID 1000。已从官方 HTTPS 校验清单独立核对 Node 22.23.1 linux-x64 归档 SHA-256 `9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578`，生产 Node 二进制与该归档逐字节一致，SHA-256 `93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068`。仅收紧版本目录、bin 目录、node 文件三处所有权为 root；未改变字节或重启业务。
- 随后隔离准备发现历史配置的 SQLCipher binding 仍指向原始 `1.9.14-675813a4649b`，且旧 release 父目录属普通账号。助手已拒绝而未启动 worker；生产仍为原 PID。仅有校验后包副本及空恢复目录，未生成恢复数据。后续须在不放宽文件哈希和信任公钥边界的前提下兼容精确历史布局，并保全失败准备记录，重新做真实恢复/启动检查。
- 上述 recurring 检查现已修复：3 处 React setter 消除同名歧义，5 处真实定时器改用受管生命周期；公开浏览器安全入口只包含调度服务，不导入 Node/Core 总入口，原内部模块限制未放宽。入口/registry 18、桌面 42、服务启动 9 项回归通过；core build、候选声明类型检查、实际 renderer webpack、lint/code-map 通过。未用旧 donor 声明的标准类型失败伪装候选通过，完整干净 CI 仍须重新执行。
- 后续测试进一步复现工具→Config→executor→guard→工具的顶层循环导入；改为在真正调用时解析同一固定原生类/原型白名单，未扩大授权。导入顺序先 5 项 RED 后 GREEN，原 5 suite 加 guard 共 121 项、额外安全约束 51 项通过。服务端测试显式 OTTO_USER_DIR 与 BYOK fixture 路径不一致的 26 项失败已修正测试路径；标准 workspace 加旧路径/旧密钥迁移测试 111 项通过，未改变模型加载授权边界。

## 发布后必须完成

1. 完成所有生产事务及其补偿，核对精确源码/包身份/资产哈希/版本/旧入口。
2. 删除上述两个临时 OAuth Secret，并验证不存在；不打印原值。
3. 恢复 `production-approval.prevent_self_review=true`，保留分支限制及审计记录；未来常规发布必须有不同于触发者的合格审批人。
4. 记录安装包实际大小、平台/升级测试、服务迁移/备份/回滚回执。未测试项明确保留，不能用离线测试数量替代。
