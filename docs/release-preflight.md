# Otto 发布前检查清单与规范

> 1.9.14 的自动化生产发布范围仅包含 `enterprise-oneclick` 单机企业服务配置。
> PostgreSQL/Redis/S3 集群代码和迁移工具仍用于独立迁移演练与金丝雀验证，不属于本次
> 稳定版自动部署配置，也不得使用本发布工作流直接提升为生产权威源。

这份文档是 Otto 的发布检查规范。自动质量、签名、部署校验与本清单要求的人工 smoke、canary、回滚演练和安全复核都是正式发布阻断项；任何一项未完成、失败或证据缺失，都不得公开 Release 或更新旧客户端镜像。

## 唯一集成基线

- 正式发布源码必须来自最新 `origin/internal`；功能分支、旧 tag 或仅在 PR 中的提交不得直接发布。
- `docs/server-integration-baseline.json` 必须与根/桌面版本、Enterprise API、数据库 schema、公开 capabilities 和产品模块注册表一致。
- 发布前必须运行 `npm run validate:integration-baseline`；失败时只能更新真实台账或源码，不能绕过门禁。
- SQLCipher、PostgreSQL、E2EE、S3/Redis 等实验分支只能按台账中的 `integrate` / `rewrite` / `drop` 决策处理，禁止整体 merge 覆盖当前园区、商业和 UI 实现。

## 0. 发布原则

- 发布源必须是 `origin/internal` 上的明确 commit；不要从本地脏树、过期 tag 或临时构建目录发版。
- 桌面端、企业服务器、GitHub Release 三者必须同步到同一版本号。
- 企业服务器升级必须先跑 canary，canary 通过后才允许切换生产 systemd。
- GitHub Actions 失败时必须查明是代码、脚本、Secrets、runner/账单还是服务器权限问题，不能把失败的自动化当作已发布。

## 0.1 长期稳定正式版门禁

1.9.14 作为长期维护的正式版本，仍使用当前受支持的 `stable` 发布渠道；`lstc` 只用于验证和迁移历史包，不能生成新的正式包。除普通 patch 门禁外还必须满足：

- 企业一键包 `manifest.json.releaseChannel` 必须是 `stable`。
- 企业一键包 `manifest.json.database.schemaTo` 必须等于 `packages/server/src/enterprise/db.ts` 中的 `ENTERPRISE_SCHEMA_VERSION`。
- `deployment/enterprise-oneclick/tools/health-check.mjs` 必须同时检查公开兼容信息和带管理员令牌的私有部署状态，管理员令牌请求禁止跟随重定向。
- `deployment/enterprise-oneclick/tools/verify-release.mjs` 必须拒绝 schema 目标过旧、文件集合漂移和未经显式兼容开关允许的历史 `lstc` 包。
- Release 说明必须写出 `stable`、锁定源码 commit、企业包三段身份、SHA-256、服务器验证结果和桌面安装包体积状态。

## 1. 源码状态

```bash
git fetch origin
git status --short --branch
git log --oneline --decorate -5
git log --oneline HEAD..origin/internal
```

必须满足：

- 当前分支是 `internal`，且和 `origin/internal` 对齐。
- 工作树干净；如果有未提交文件，必须明确属于本次 release 并已 commit。
- `HEAD..origin/internal` 为空；否则先合入远端最新提交。
- 不重写已发布 tag；如果 tag 指错，开新 patch 版本。

## 2. 版本一致性

```bash
node -p "require('./package.json').version"
node -p "require('./packages/desktop/package.json').version"
```

必须满足：

- 根 `package.json` 和 `packages/desktop/package.json` 版本一致。
- Release tag 使用 `vX.Y.Z`。
- GitHub Release 标题、桌面安装包名、企业包名、服务器公开
  `/enterprise/health.appVersion` 与认证后的
  `/enterprise/deployment/status.runtime.version` 使用同一版本。

## 3. 问题回归

发布前必须逐条复核本版本修过的问题，至少覆盖：

- 旧版本升级后是否能自动恢复已修复问题。
- 企业账号、个人账号、未登录账号的权限边界是否符合预期。
- 宏创园区入口、企业树、企业记忆、A2A、企业私聊、未读提醒是否没有被 capability gate 误伤。
- 旧服务器能力缺失时，客户端是否显示可理解错误，而不是白屏或崩溃。

每个问题必须记录：

- 问题标题或 issue 编号。
- 对应 commit。
- 验证命令或实机验证结果。
- 是否需要服务器同步升级。

## 4. 本地验证顺序

先跑低成本检查，再跑重检查：

```bash
npm run doctor
git diff --check
npm run typecheck --workspace=packages/core
npm run typecheck --workspace=packages/server
npm run typecheck --workspace=packages/desktop
npx vitest run packages/core/src/telemetry/metrics.test.ts packages/core/src/telemetry/loggers.test.ts packages/desktop/src/main/enterprise-client.test.ts packages/server/src/enterprise/server.test.ts
```

如果改动涉及共享协议、企业服务、桌面 preload/main/renderer 边界，再加：

```bash
npm run build --workspace=packages/server
npm run build --workspace=packages/desktop
```

规则：

- 失败即停止发版。
- 跳过任何测试都必须写明原因。
- 只跑 focused tests 时，要说明为什么 blast radius 不需要全量测试。

## 5. 桌面安装包

正式桌面 release 必须执行：

```bash
npm run release --workspace=packages/desktop
```

必须满足：

- mac arm64 DMG 已生成
- mac x64 DMG 已生成
- Windows x64 installer 已生成
- `latest.json` 的 sha256 与实际资产一致
- 正式 `stable` 的 Windows installer 和 Otto native 均通过 Authenticode；两个 macOS DMG 内应用均通过 Developer ID、notarization 和 stapler 验证。
- 缺少任一签名/公证凭据时，只允许创建 `transition + draft + prerelease` 的测试产物；不得部署企业服务、公开 Release 或更新任何自动更新入口。

必须记录桌面安装包体积；包体增长异常时先查 `app.asar`、Electron Framework、`node_modules` 最大项，不得为了体积删除运行时必需文件。

## 6. 企业服务器发布包

构建企业包：

```bash
node scripts/build-enterprise-oneclick.mjs
sha256sum deliverables/otto-enterprise-oneclick-vX.Y.Z-*.tar.gz
cat deliverables/otto-enterprise-oneclick-vX.Y.Z-*.tar.gz.sha256
```

必须满足：

- `verify-release.mjs` 通过。
- `manifest.json.sourceCommit` 是本次要发布的 commit。
- `manifest.json.buildCommit`、`sourceInputSha256` 与企业包文件名中的两个 12 位前缀一致，完整值均由构建脚本和签名清单复核。
- `sourceTreeDirty` 为 `false`。
- 包内包含 `server.js` 直接或间接 import 的所有运行时模块。
- 最小 `otto-core` adapter 导出企业服务器实际使用的符号。

企业包改动后必须至少跑一次有界解包和安装器深度 dry-run。这个步骤验证清单、
SQLCipher、迁移与数据对账，但不冒充服务 canary：

```bash
PRECHECK_CONFIG=/安全目录/预发布-enterprise.env
mapfile -d '' archives < <(find deliverables -maxdepth 1 -type f \
  -name 'otto-enterprise-oneclick-vX.Y.Z-*.tar.gz' -print0)
[ "${#archives[@]}" -eq 1 ]
CHECK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/otto-enterprise-check.XXXXXXXX")"
case "$CHECK_ROOT" in
  "${TMPDIR:-/tmp}"/otto-enterprise-check.*) ;;
  *) exit 1 ;;
esac
cleanup_precheck() { rm -rf --one-file-system -- "$CHECK_ROOT"; }
trap cleanup_precheck EXIT HUP INT TERM
tar --no-same-owner -xzf "${archives[0]}" -C "$CHECK_ROOT"
mapfile -d '' package_dirs < <(find "$CHECK_ROOT" -mindepth 1 -maxdepth 1 \
  -type d -name 'otto-enterprise-oneclick-vX.Y.Z-*' -print0)
[ "${#package_dirs[@]}" -eq 1 ]
node "${package_dirs[0]}/tools/verify-release.mjs" "${package_dirs[0]}/release"
"${package_dirs[0]}/install.sh" --config "$PRECHECK_CONFIG" --dry-run
```

真正的服务 canary 必须在目标 Ubuntu 的 root 网关事务内执行：新装与升级都先在
隔离数据库和回环端口启动完整 release、通过 health 后才允许切换 systemd。主发布
workflow 的生产部署结果是这一 gate 的签发证据；不得用上面的 dry-run 替代。

## 7. GitHub Release 与事务回退能力

创建或更新 Release 前检查：

```bash
gh auth status
gh release view vX.Y.Z --json tagName,targetCommitish,isDraft,assets,url
gh run list --limit 8
```

必须满足：

- Release 资产名和本次实际部署包一致。
- `.tar.gz`、`.sha256` 和 Ed25519 `.sig` 同时上传。
- `NSIETeam/otto-new` 和 `Felix201209/otto-releases` 都不存在同名 Release；不得覆盖、删除后重传或修改已发布资产，内容变化必须发布新的 patch 版本。
- 两个仓的 immutable releases 必须保持关闭，且两个独立细粒度令牌分别以 Metadata read + Administration read 访问 `/actions/permissions` 返回 200、访问 `/immutable-releases` 返回 404。无法证明权限或关闭状态即停止。
- `production-automation` 已配置 `OTTO_CANONICAL_ADMIN_READ_TOKEN`、`OTTO_LEGACY_ADMIN_READ_TOKEN` 和兼容仓 Contents-write 令牌；这些令牌不得输出到日志。
- `production-automation` 已配置 `OTTO_ENTERPRISE_PUBLIC_URL`，值只能是企业服务真实公网 HTTPS origin（不得包含凭据、路径、查询或片段）；工作流必须从 GitHub runner 经真实 TLS 边界验证 `/enterprise/health`，不能用服务器 localhost 检查替代。
- 如果 Actions job `steps: []` 且 runner id 为空，这是 runner/账单/额度层失败，不是脚本通过。

`prepare-release-creation-intent` 必须在创建任一 tag/Release 前连续读取两个仓库的精确
远端状态，并确认两次结果完全相同。`otto-release-creation-intent-v1` 记录必须绑定本次
run id、tag、两仓、完整锁定源码 commit、兼容仓 `main` commit、两仓 tag 预存在状态、
Release 不存在、名称、正文摘要、预发布标志、完整 14 资产向量和
`otto-pre-public-latest-v1` 快照；每个 latest 指针保存 Release id + tag，此前没有 latest 时
保存 `null`。两个文件及各自 SHA-256 必须作为
`otto-release-creation-intent-<tag>` artifact 在第一次 GitHub 写入前上传；
`create-release-drafts`、正式公开和任何补偿都必须重新下载并验摘要，不能根据故障后的
仓库状态推测旧指针。

`create-release-drafts` 失败或取消时，清理 job 必须覆盖该 DAG 结果并可幂等续跑。只有
部分 Release 仍为身份/正文/target 完全一致的 draft、已有资产是锁定向量的严格子集
（允许名称已锁定且 size=0、digest 为空的 `starter` 上传）、tag commit 未漂移且 latest
仍为发布前值时，才可删除本 run 的草稿和本 run 新建的 tag。正式 tag push 前已存在的
正式仓源码 tag 必须保留；公开 Release、未知资产或任何歧义均禁止自动删除。

公开阶段必须先公开并完整复核 `NSIETeam/otto-new`，随后上传、复核并原子切换更新镜像，最后才公开并复核旧客户端兼容仓
`Felix201209/otto-releases`。两个 GitHub Release 中的 `latest.json` 必须使用 GitHub asset URL；两个仓库必须保持 public，且工作流要在不发送 Authorization/Cookie 的情况下下载并核验正式仓 `latest.json`、三个安装包与三个 blockmap 的大小和 SHA-256。镜像使用独立生成并经证明的 `latest.mirror.json`（上传到镜像时重命名为 `latest.json`），该内部文件不得成为 GitHub Release 资产。若镜像或兼容仓事务失败，先完成镜像回滚，再从目标 Release
移除 `latest` 并按快照中的 Release id + tag 精确恢复两个仓此前的 `latest`。已经公开且
可能被客户端观察到的 Release 绝不改回 draft，资产不得删除、覆盖或让既有下载 URL
失效；从首次公开起该版本号永久烧毁，恢复闭环后只能使用新的 patch 版本。

从创建草稿前到工作流完全结束，冻结 `internal`、immutable releases 设置、tag、Release 资产和镜像人工操作；批准后禁止人工取消工作流。

生产发布、企业部署、镜像发布和自动补偿 job 都禁止使用 GitHub **Re-run jobs**。失败或平台中断时，先按恢复手册确认/回滚企业部署、镜像与双仓 Release 状态；恢复闭环后，从届时最新且完全锁定的 `origin/internal` 源码创建新的 patch 版本并启动全新的 workflow run。不得重放原运行的部分 job，也不得复用已创建的版本 tag/Release。

若中断留下网关上传目录，必须先确认原 workflow 已终止，并按签名包身份完成部署与镜像状态核对；随后只对原事务号执行 `cleanup-upload enterprise <original_transaction_id>` 和 `cleanup-upload mirror <original_transaction_id>`。不得提前清理仍可能被原运行使用的目录，也不得用新事务号规避待清理事务。

## 8. 企业服务器升级

正式发布只能使用主 Release workflow 调用 `.github/workflows/deploy-server.yml`。该 CI 网关只允许升级已经存在且可验证的 one-click `current`；全新服务器首装必须在发布窗口前由管理员人工审计并运行 `install.sh`，不得把自动首装伪装成可补偿事务。GitHub runner、Secrets、生产审批或服务器信任边界不可用时必须停止发布；不得临时改成直接执行包内脚本。独立手动部署也必须经过 `production-approval`，只用于已审计恢复或 dry-run。

发布窗口前由服务器管理员从本次锁定源码重新安装 root 网关和两个镜像 helper。工作流的 `preflight` 必须精确匹配：

- `protocol=otto-enterprise-ci-deploy-v5`
- `config=/etc/otto-enterprise/enterprise.env`，必须逐字等于服务器 root 固定的生产配置路径
- `deploy_user` 与 `rollback_user` 均与本次固定安装配置一致，且是两个不同的非 root 账号
- 已安装网关、publish helper、rollback helper 与锁定源码的 SHA-256
- 服务器固定 Ed25519 公钥 key id 与 runner 复核公钥一致

主工作流随后自动执行签名验证、root staging、隔离迁移 canary、数据库备份、systemd 切换和精确部署身份复核。验收必须满足：

- root 网关 `verify-deployment <transaction_id> <version> <package_identity> <source_commit>` 返回与事务、版本、包身份和源码提交精确绑定的部署回执；四个值都必须从本次锁定 workflow 和签名 manifest/metadata 取得，不得手工猜测。
- 公网验收成功后必须调用 `finalize-deployment` 删除该事务的 root-only 回滚快照；公网验收失败或已提交事务的后续 job 未完整成功时，必须由只持有独立回滚私钥的 job 调用 `rollback-enterprise`，核对精确回滚回执并重新验收此前锁定版本。
- 公网 `/enterprise/health` 只返回兼容信息：`status: ok`、`service: otto-enterprise`、精确 `version` 与 `appVersion`、当前 `apiVersion` 和所需 `capabilities`；其中 `version` 和 `appVersion` 都必须等于本次发布版本。
- 公网 health 不得包含 `buildCommit`、`schemaVersion`、`db`、部署、许可证、运行时或短信私有状态。
- 私有 `/enterprise/deployment/status` 仅在服务器本地通过管理员令牌检查，并要求
  `runtime.version` 精确等于发布版本、`runtime.buildCommit` 精确等于签名 manifest 的完整
  build commit，同时确认 schema、数据库完整性、SQLCipher 和许可证强制执行状态；令牌
  请求禁止重定向。
- `systemctl is-active otto-enterprise` 为 active，公网 TLS 证书验证正常；不得使用 `curl -k` 绕过证书错误。

## 9. 发布后验证

发布后必须做一次真实客户端验证：

- 启动当前桌面客户端。
- 登录企业账号。
- 展开企业树。
- 打开宏创园区面板。
- 检查企业记忆列表。
- 检查企业消息/未读轮询不再报“服务器版本过旧或功能不完整”。

最后记录：

- 发布 commit。
- GitHub Release URL。
- 企业服务器认证状态中的精确 `runtime.version` 与 `runtime.buildCommit`。
- 服务器备份目录。
- 桌面安装包大小。
- 未解决风险。

## 10. 回滚规范

回滚前先判断是否已有新业务写入。

允许快速回滚的条件：

- 新版本刚切换，未产生新注册、企业邀请、工单、消息、记忆写入。
- 旧 release 目录和 `data.db*` 备份完整。

禁止直接回滚的条件：

- 新版本已接收业务写入。
- 数据 schema 已升级且旧服务不支持。
- 备份不完整。

回滚动作必须留下记录：

- 回滚原因。
- 回滚到的 release/buildCommit。
- 使用的备份目录。
- 回滚后 health 结果。
