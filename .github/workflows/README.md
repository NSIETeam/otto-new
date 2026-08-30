# GitHub Actions Workflows

1.9.14 的生产部署工作流只部署并验收 `enterprise-oneclick` 单机企业服务；它不部署、
也不为 PostgreSQL/Redis/S3 集群配置提供稳定版生产背书。集群提升必须使用独立迁移与
兼容性验收流程，不能复用这里的单机健康检查作为放行依据。

Otto 的发布链路分成三段：先检查异常，再锁定双仓发布前的 `latest` 指针并构建
GitHub Release 草稿，最后依次部署企业服务器、公开双仓 Release 和同步桌面更新镜像。

发布前必须先完成 `docs/release-preflight.md`；本文件只说明 Actions 如何执行，不替代发布门禁。

## 当前正式发布门禁

- 发布源 `HEAD` 必须与远端 `origin/internal` 的最新提交精确相等；`release/*` 上的额外提交、旧 tag、落后分支和未合并功能分支都不能生成正式版本。
- 根目录与桌面端版本号必须一致，企业运行时 schema、清单、构建信息均从同一提交生成。
- macOS 必须通过 Developer ID 签名、公证和 stapler 验证；Windows 必须通过 Authenticode 验证。
- 企业一键部署包必须带外置可信公钥可验证的 Ed25519 `.sig`，只有 SHA-256 不允许发布。
- 独立的 `prepare-release-creation-intent` 作业会在任何 tag/Release 写入前连续读取并锁定双仓状态，把 run id、tag、两仓、完整源码 commit、兼容仓 `main` commit、两仓 tag 是否预先存在、Release 不存在、名称/正文/预发布标志、完整 14 资产向量和发布前 `latest` 写入创建意图。`creation-intent.json` 与 `pre-public-latest.json` 的 SHA-256 在第一次写入前作为不可变 workflow artifact 上传；`create-release-drafts` 必须下载、验摘要并连续两次复核远端状态后才可创建草稿。
- 若 `create-release-drafts` 失败或取消，`cleanup-partial-release-drafts` 会在同一 DAG 中以 `always()` 运行。只有 Release 仍是身份、正文、target、预发布标志完全一致的 draft，已有资产是锁定向量的严格子集（含名称锁定且 size=0、digest 为空的 `starter` 上传），tag commit 未漂移且两仓 `latest` 仍等于发布前值时，才删除本 run 的部分草稿和本 run 新建的 tag。正式 tag push 触发前已经存在的正式仓源码 tag 永远保留；任何公开 Release 或歧义状态都停止并交由人工事故处理。清理算法可幂等续跑。
- 正式发布顺序是：构建并验签草稿 -> 部署企业服务 -> 公开 `NSIETeam/otto-new` 并复核 -> 最后公开旧客户端兼容仓并复核 -> 事务性更新国内镜像。兼容仓是 Release 公开阶段的最后一次公共变更，不能先于正式仓暴露。若镜像更新失败，必须先成功回滚镜像，再用发布前快照从目标版本移除 `latest` 并精确恢复两仓此前的 `latest` 指针。
- 任何已公开并可能被客户端观察到的 Release 都绝不改回 draft，也不删除或覆盖资产。补偿后目标 Release 保持原公开/预发布可见性，只是不再是 `latest`；该版本号视为永久烧毁，事故闭环后必须使用新的 patch 版本重新发布。
- 从创建草稿前到流程完全结束，必须冻结 `internal`、两仓 immutable releases 设置、tag、Release 资产和镜像的人工修改。工作流会在建草稿和企业部署前重新读取 `internal`；企业部署开始后，以已锁定提交作为事务提交点，不能因新提交制造半发布状态。
- 两个 Release 仓必须关闭 immutable releases。工作流先通过 `/actions/permissions` 证明令牌具备 `Administration: read`，再要求 `/immutable-releases` 明确返回未启用；无法证明时一律停止。

## CI

文件：`.github/workflows/ci.yml`

触发：

- PR 到 `internal` / `main`
- push 到 `internal`

主要检查：

- `npm run doctor`
- `git diff --check`
- 主链路 build
- workspace typecheck
- core/server/cli/desktop tests
- release 关键回归测试：桌面企业客户端、packaging contract、server、enterprise server

## Release Build

文件：`.github/workflows/release.yml`

触发：

- push tag：`v*.*.*`
- 手动 `workflow_dispatch`

输出：

- `Otto-<version>-arm64.dmg`
- `Otto-<version>-x64.dmg`
- `Otto-Setup-<version>-win-x64.exe`
- blockmap
- `latest.json`
- `otto-enterprise-oneclick-v<version>-<build>.tar.gz`
- `.sha256`
- `.sig`

规则：

- 根 `package.json` 与 `packages/desktop/package.json` 必须等于目标版本。
- 桌面安装包必须存在，并随 `latest.json` 一起发布用于校验和更新。
- `NSIETeam/otto-new` 是正式 Release；`Felix201209/otto-releases` 同步同一份资产，作为 V1.9.13 及更早客户端的兼容入口。
- Release 默认先创建为 draft；创建前锁定并上传 SHA-256 绑定的完整创建意图和双仓发布前 `latest` 快照。企业部署和安装包验签通过后，工作流先公开并复核正式仓，再把兼容仓作为最后一个 Release 端点公开，随后事务性更新旧客户端镜像。镜像失败时先回滚镜像，再校验同一快照摘要并精确恢复此前 `latest`；已经公开的目标 Release 与资产保持可下载，不会退回 draft。
- root 网关 `preflight` 必须返回且仅返回与本次源码和固定安装配置完全一致的 `protocol`、`gateway`、`publish`、`rollback`、`key`、`config`、`deploy_user`、`rollback_user`；旧网关、helper、信任锚、配置路径或账号身份漂移都会在上传前失败。

## macOS Preview Build

文件：`.github/workflows/macos-preview.yml`

这是不进入正式更新渠道的手动测试构建。它只接受远端 `internal` 的
精确最新提交，并执行仓库质量门禁与 SQLCipher 来源验证。Apple custody
齐全时继续执行 Developer ID 签名、公证和 Gatekeeper 校验，文件名为
`Otto-macOS-Preview-arm64.dmg` 与 `Otto-macOS-Preview-x64.dmg`；缺少 custody
时只生成明确标记的 `Otto-macOS-Preview-Unsigned-<arch>.dmg`，使用 ad-hoc
应用签名和 DMG 完整性校验，不能冒充正式分发包。文件名均不带产品版本；
`provenance.json` 保存内部版本、来源提交、工作流运行编号和签名状态。
任一 DMG 超过 120 MiB 时工作流直接失败，不上传超限测试包。

产物仅作为保留 14 天的 Actions artifact，不创建 tag、GitHub Release、
`latest.json`，也不触碰正式或兼容下载仓库及更新镜像。

## Deploy Server

文件：`.github/workflows/deploy-server.yml`

触发：

- 手动 `workflow_dispatch`

行为：

- 下载当前 release workflow 的锁定 artifact，或下载指定 Release 中身份精确匹配的
  `otto-enterprise-oneclick` 包、SHA-256 与 Ed25519 签名。
- 由 root 网关在 `/var/lib/otto-ci-deploy/uploads/...` 创建单次、最小权限上传目录。
- root 网关在固定信任公钥下复核签名、包身份与源码提交，再由包内受审计脚本执行
  canary、备份、安装或升级；runner 不能直接执行上传的脚本。
- 支持手动 dry-run。

目标服务器要求：

- Ubuntu 22.04/24.04
- systemd
- 部署用户只能免密调用 root-owned 固定网关 `/usr/local/sbin/otto-enterprise-ci-deploy`
- 已有部署应由 one-click current symlink 管理

GitHub 仓库必须预先创建两个受保护 Environment：`production-approval` 只供正式签名构建，配置必要审批人并禁止自审；`production-automation` 保存 Release 写入、服务器部署和镜像凭据，不配置人工等待，但必须只允许受保护的 `internal` 分支及正式 `v*` 标签。自动回滚也绑定 `production-automation`，避免故障时再次等待人工审批。生产秘密必须从 Repository secrets 迁入对应 Environment；发布前还必须核对默认分支保护，禁止未审查的分支工作流接触生产凭据。

首次启用自动部署前，管理员必须按
`deployment/enterprise-oneclick/README.zh-CN.md` 的 bootstrap 章节，从已验签且解压到
root 管理目录的正式包安装网关、固定 Ed25519 信任公钥、镜像 helper 和最小 sudoers
规则。每次这些文件变更都要在发布窗口前由管理员重新安装；Actions 会逐字节比对三项 SHA-256 和 key id。工作流不会接收 sudo 密码，也没有权限自举或替换这条 root 信任边界。

## Required Secrets

`production-approval`（有审批人）：

- `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`
- `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
- `OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY`、`OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY`
- `OTTO_LICENSE_PUBLIC_KEYS`（JSON 数组或单个 Ed25519 SPKI 公钥；私钥不得进入仓库或客户服务器）

`production-automation`（无人工等待，严格限制受保护来源）：

- `OTTO_LEGACY_RELEASES_TOKEN`（仅需对 `Felix201209/otto-releases` 的 Contents 写权限；用于迁移期兼容旧客户端）
- `OTTO_CANONICAL_ADMIN_READ_TOKEN`（仅授予 `NSIETeam/otto-new` 的 Metadata read 与 Administration read；用于证明 immutable releases 已关闭）
- `OTTO_LEGACY_ADMIN_READ_TOKEN`（仅授予 `Felix201209/otto-releases` 的 Metadata read 与 Administration read；用于证明 immutable releases 已关闭）
- `OTTO_ENTERPRISE_PUBLIC_URL`（企业服务对外 HTTPS origin，例如 `https://enterprise.example.com`；不得包含凭据、路径、查询或片段）
- `DEPLOY_HOST`
- `DEPLOY_USER`（仅部署/发布账号；不能执行镜像回滚）
- `DEPLOY_SSH_KEY`（仅对应 `DEPLOY_USER`）
- `ROLLBACK_DEPLOY_USER`（独立回滚账号；必须与 `DEPLOY_USER` 不同，只能预检和回滚镜像）
- `ROLLBACK_DEPLOY_SSH_KEY`（仅对应 `ROLLBACK_DEPLOY_USER`，不得与部署私钥相同）
- `DEPLOY_KNOWN_HOSTS`（目标服务器的固定 OpenSSH known_hosts 条目；不得使用运行时 ssh-keyscan）
- `OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY`（同时在 runner 复核包签名；服务器仍使用人工预置的独立固定副本再次验签）

可选：

- `DEPLOY_PORT`，默认 `22`

部署配置路径由服务器 root 管理的 `/etc/otto-enterprise/ci-deploy-config-path` 固定，且只能
指向 `/etc/otto-enterprise/` 下 root-owned、不可组/其他用户写入的 `.env` 文件；它不是
GitHub Secret，也不能由一次发布临时改写。

正式 Release 使用 `NSIETeam/otto-new` 当前工作流的 `GITHUB_TOKEN`。旧客户端兼容副本使用权限最小化的 `OTTO_LEGACY_RELEASES_TOKEN`；在兼容期结束前不得删除该 Secret 或停止同步旧发布仓。

以上生产 Secret 不得在 Repository secrets 中保留副本。`production-automation` 不设人工审批是为了保证自动回滚不会等待第二次批准，它的安全边界必须由 Environment 的受保护分支/标签策略、`internal` 分支保护和工作流内的精确提交校验共同承担。

## Manual Release

```bash
VERSION="$(node -p "require('./package.json').version")"
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

等待 `Release Build` 完成签名、部署和镜像核验，并自动先公开正式仓、后公开兼容仓。不要在工作流完成前手动公开草稿或调整任一仓的 `latest`。正式生产 job 不支持 GitHub 的 **Re-run jobs**：失败或强制中断后必须先按下节完成恢复；只要任一 Release 曾公开，本版本就不得复用，必须从仍与 `origin/internal` 一致的源码以新的 patch 版本启动一个全新的、经审计的 workflow run。

## 发布中断恢复

批准 `production-approval` 后，禁止人工点击 **Cancel workflow**。GitHub 取消运行不能保证尚未启动的补偿 job 一定执行；发布窗口内也不得推送 `internal`、开启 immutable releases，或手工编辑 tag、Release 资产和镜像文件。

若运行因平台故障被强制中断：

1. 记录 `TAG`、`GITHUB_RUN_ID`、`GITHUB_RUN_ATTEMPT`，镜像事务号固定为 `${TAG}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`。
2. 先通过固定网关执行 `preflight`。若企业部署 SSH 回包丢失，用 `verify-deployment <version> <package_identity> <source_commit>` 核对当前服务器是否已经是该签名构建；三个值必须来自锁定 workflow artifact 的签名 manifest/metadata。不得凭 Actions 的失败状态直接回滚可能已经接收新写入的数据库。
3. 确认原 workflow run 已终止、服务器上没有仍在运行的上传或网关进程，并完成上一步的部署状态核对后，才可清理该原事务遗留的上传目录：依次执行 `cleanup-upload enterprise <original_transaction_id>` 与 `cleanup-upload mirror <original_transaction_id>`。只能使用原事务号；不得为了绕过 “pending cleanup” 改用新事务号，也不得在原运行仍可能恢复时提前清理。
4. 使用独立的 `ROLLBACK_DEPLOY_USER`/`ROLLBACK_DEPLOY_SSH_KEY` 对该事务执行 `rollback-mirror <transaction_id>`，保存它最后一行返回的 `restored_manifest_sha256=<digest|absent>`；部署账号不得执行此命令。已进入公开认领阶段的事务还必须持有发布器为该事务生成、限时且一次性的 root-only 回滚能力票据；它会在事务未公开时安全返回，在镜像已被后续事务接管或票据不匹配时拒绝回滚。
5. 读取 root-only 的 `/opt/otto-website/transactions/<transaction_id>/UPDATE-MIRROR-SHA256SUMS`、同目录签名 envelope 和 `published-latest.json`，以前者逐项记录全部六个版本化资产（包括三个 blockmap）的名称和 SHA-256，并与 `/opt/otto-website/downloads/` 中已出现的同名普通文件核对。发布器会在第一个版本化资产公开前先持久化这三份审计材料和 `claiming`；从该标记出现起版本即永久烧毁，服务端也会拒绝其他 run-id 再用同一版本。中断时已出现的已验证资产会永久保留：它们可能已被客户端缓存，不能安全删除；恢复后的公开 `latest.json` 不得再引用它们，后续发布也不得复用该版本或覆盖同名文件。文件缺失、hash 不同、路径越界或无法证明是否曾公开时，立即升级为人工事故处理。
6. 从公网 HTTPS 更新入口重新下载 `latest.json`，禁止重定向，并确认其 SHA-256 精确等于第 4 步的 digest；若返回 `absent`，公网必须为 404。同时确认它不引用第 5 步记录的孤立资产。公网尚未收敛时不得修改 GitHub Release 的可见性或 `latest` 指针。
7. 下载本次 run 在第一次 GitHub 写入前由 `prepare-release-creation-intent` 上传的 `otto-release-creation-intent-<tag>` artifact，并将 `creation-intent.json` 与 `pre-public-latest.json` 的 SHA-256 分别与该 job 输出的摘要精确比较；嵌入创建意图的 `prePublicLatest` 还必须与独立快照逐字段一致。禁止根据当前 `/releases/latest` 猜测“上一个版本”。
8. 公网镜像恢复且第 7 步校验通过后，使用锁定提交中的补偿工具让目标 Release `make_latest=false`，并按快照中的 Release id + tag 分别精确恢复两个仓此前的 `latest`（此前为 `null` 时仍须验证为 `null`）。补偿前后都要核对 Release 身份、14 个资产、正文摘要和目标提交。已经公开的 Release 绝不改回 draft，资产不得删除或覆盖；不能证明精确恢复时停止操作并升级为人工事故处理。
9. 核对公网 `/enterprise/health.appVersion`，再通过管理员令牌核对 `/enterprise/deployment/status.runtime.version` 与 `runtime.buildCommit` 的精确身份、数据库写入与备份状态。不得对原运行点击 **Re-run jobs**；只要任一端点曾公开或镜像进入 `claiming`，同版本永久烧毁。事故处理完成后应修订为新的 patch 版本，从届时最新且完全锁定的 `origin/internal` 提交启动全新发布。

自动恢复 job 使用无人工等待的 `production-automation`；若该 Environment 被错误配置为需要审批，应先视为发布阻断项修正配置，不能在故障后临时绕过保护规则。

## Manual Server Dry Run

Actions -> Deploy Enterprise Server -> Run workflow（独立手动部署会强制进入 `production-approval`，审批后才可读取自动化部署凭据）：

- `version`: 必须与根目录及桌面端 `package.json` 的版本完全一致
- `package_identity`: 必须取自已验签企业包文件名 `otto-enterprise-oneclick-v<version>-<buildCommit前12位>-<sourceInputSha256前12位>.tar.gz` 的最后两段，例如 `0123456789ab-fedcba987654`；不得自行编造
- `source_commit`: 必须是签名 manifest 中的完整 40 位 `sourceCommit`，并与该包及待验证的 `origin/internal` 提交一致
- `dry_run`: true
- `release_repository`: 默认 `NSIETeam/otto-new`；仅在明确从旧兼容发布仓取同一份已验签资产时选择 `Felix201209/otto-releases`

dry-run 只会在目标机解包、校验、迁移 canary 和 health，不切换生产 `current`。
