# Otto 仓库迁移与更新兼容策略

## 仓库角色

- `NSIETeam/otto-new`：唯一可写源码仓、默认开发推送目标、正式 GitHub Release 仓。
- `Felix201209/otto`：旧源码仓，只保留历史查询，不再接收提交、分支或标签。
- `Felix201209/otto-releases`：旧客户端兼容发布仓，不属于“旧源码仓只读”的范围。兼容期内必须继续接收与正式 Release 完全相同的安装包，以及使用 GitHub asset URL 的同一份 GitHub `latest.json`。
- `https://59.110.154.44:7777/otto-releases/latest.json`：V1.9.11 至 V1.9.13 的首选更新入口，必须长期可用并保持原子更新。

## 发版不变量

1. Release 源提交必须存在于 `NSIETeam/otto-new`，且包含最新 `origin/internal`。
2. 安装包、企业服务包、签名、校验和、GitHub `latest.json` 与独立镜像清单 `latest.mirror.json` 必须由同一次工作流构建并证明；内部镜像清单不得作为 GitHub Release 资产。
3. `prepare-release-creation-intent` 在任何 tag/Release 写入前稳定读取两个仓库各自精确的
   `latest` Release id + tag（允许为 `null`），把它们与本次 run、tag、仓库身份、完整
   锁定源码 commit、兼容仓 main commit、tag/Release 预存在状态及完整资产身份写入创建
   意图；创建意图与 latest 快照的 SHA-256 由 job 输出，并在第一次写入前作为不可变
   artifact 上传。创建失败或取消时，只能据此幂等删除身份完全匹配的 draft 与本 run
   新建 tag，正式 push 前已有的源码 tag 必须保留。
4. 工作流创建新旧两个草稿并完成验签、企业部署后，先公开并复核
   `NSIETeam/otto-new` 正式 Release，再使用独立镜像清单原子切换并复核服务器镜像，最后才公开并复核旧客户端兼容 Release。
   两个仓必须保持 public；工作流使用无 Authorization/Cookie 的下载请求复核正式仓
   `latest.json` 及六个桌面资产的大小和 SHA-256，并在兼容仓公开后再次匿名复核。
5. 任一兼容发布失败都必须使整次发版失败；不得只更新新仓后宣称老用户可正常更新。
   补偿必须重新校验发布前快照摘要，从目标版本移除 `latest`，并按快照中的 id + tag
   精确恢复两仓此前的 `latest`，不能依赖 GitHub 当时推算的“上一个版本”。
6. 已公开且可能被客户端观察到的 Release 绝不改回草稿，资产不得删除或覆盖。即使
   `latest` 已精确恢复，该版本号也永久烧毁；恢复后必须使用新的 patch 版本重新发布。
7. 企业部署的 finalization 必须晚于正式仓、镜像、兼容仓的全部公开验收；发布失败时，
   只有所有已变更公开端点的补偿均成功，才允许用独立 rollback principal 回滚服务器。
   补偿失败或结果不确定时保留未 finalize 的服务器事务供人工协调恢复。

## Secret 迁移门禁

GitHub 不允许读取或复制既有 Secret 的值。启用新仓发版前，仓库管理员必须在 `NSIETeam/otto-new` 配置 `.github/workflows/README.md` 列出的签名、许可证与部署 Secret，并额外配置 `OTTO_LEGACY_RELEASES_TOKEN`。该令牌只授予 `Felix201209/otto-releases` 的 Contents 写权限。

## 结束兼容期

只有在遥测或支持台数据能够证明所有仍受支持的安装版本都已升级到包含 `NSIETeam/otto-new` 更新入口的桥接版本后，才可另行评审停止旧发布仓同步。旧源码仓可以先只读，但不得因此归档或停用旧发布仓。
