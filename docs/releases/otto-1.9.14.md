# Otto 1.9.14 发布候选说明

## 发布目标

1.9.14 基于 `internal` 产品基线，合并经过审计的企业服务、桌面端、新 UI、园区服务、模型调用、数据保护和打包修复。发布流程保持“先锁定双仓发布前状态、再创建草稿和验证、最后按正式仓、更新镜像、兼容仓的顺序公开”的事务顺序。签名或服务器部署在公开前失败时不会向用户暴露新版本；正式仓公开后的任一步失败都先回滚镜像（如已切换），再按锁定快照恢复两仓此前的 `latest`，已经公开的目标 Release 不会退回草稿，版本号也不会复用。

## 主要修复

- 企业功能将后台配置、许可证授权和实际生效状态分开处理。只有许可证租户与持久化部署身份一致且 bootstrap 完成后，商业接口和界面才会开放。
- 企业登录页不再因首次打开或服务器地址变化自动执行 bootstrap；仅在用户明确点击重新连接后准备服务器，减少无意的网络副作用。
- 托管模型和自定义 OpenAI、Anthropic、Gemini 提供方只允许在可证明“请求未发送”时自动重试。HTTP 429、全部 5xx、超时、流中断和连接重置一律停止自动重放并标记结果未知，避免重复推理和重复计费。
- 离线消息队列仅允许安全读取操作，加入数量、时间和连接代际边界；写入请求不会在重连后被隐式重放。
- 计费 admission hold 和过期用量回执增加原子认领、幂等冲突和不确定状态对账。
- 检测到既有加密备份而密钥缺失或被替换时 fail closed，并保留恢复密钥托管信息。
- 后台记忆维护和空闲上下文压缩默认不创建周期计时器；只有用户明确开启后台模型任务后才运行。
- MCP 大响应临时文件采用可停止、`unref` 的单次清理任务，避免空闲唤醒随会话数量增长。

## 原生运行时和安装包

- Rust 工具链固定为 `1.97.1`，Windows x64、macOS x64 和 macOS arm64 原生程序分别在对应官方 runner 构建。
- 打包前验证原生程序的架构、源码提交、工具链、清单、SHA-256 和运行时 ping；GitHub Actions 为原生程序及最终候选制品生成构建来源证明。
- `@otto/native` 在 `app.asar` 中只保留运行时入口，平台二进制和清单放在 `resources/otto-native/<platform>-<arch>`。
- 安装包排除 source map、测试、文档示例、Rust `target`/源码、中间构建文件和多余 TypeScript 配置；发布门禁限制 Windows 安装包相对 1.9.13 最多增长 8 MiB，并限制 `app.asar` 不超过 120 MiB。

## 老版本更新兼容

- 同一次构建生成两份内容事实相同、下载基址不同的更新清单：两个 GitHub Release 都发布使用 GitHub asset URL 的 `latest.json`；服务器镜像使用工作流内部的 `latest.mirror.json`，上传时才重命名为镜像端的 `latest.json`。`latest.mirror.json` 只作为受证明的工作流 artifact 传递，绝不出现在任一 GitHub Release 的公开资产集合中。
- 正式稳定流程在创建草稿前连续读取并锁定新仓库和兼容仓库各自精确的 `latest` Release id + tag，把绑定 tag、仓库和完整源码 commit 的快照及其 SHA-256 上传为不可变 artifact；公开或补偿前都重新验证该摘要。
- Windows Authenticode、macOS Developer ID/公证、企业包签名和服务器部署通过后，先公开并复核 `NSIETeam/otto-new`，再上传、复核并原子切换更新镜像，最后才公开并复核 `Felix201209/otto-releases`。兼容仓永远是最后一个公开端点，避免其客户端观察到尚未落地的镜像资产。
- 发布前必须以未携带 Authorization/Cookie 的请求证明两个 Release 仓均为 public；正式仓公开后及兼容仓公开前后，还要匿名下载 `latest.json` 与其中对应的三个安装包、三个 blockmap，并逐个复核大小和 SHA-256。兼容仓中的同一份 GitHub 清单因此只会引用已经证明可匿名访问的正式仓资产。
- 已复核 `release/1.9.13-transition` 的更新 URL 白名单：它接受 `github.com` 及 GitHub 官方下载所用的 `*.githubusercontent.com` HTTPS 地址，因此兼容仓中的清单引用正式仓 GitHub 资产时，既有 1.9.13 客户端仍可通过原有安全校验并完成下载。
- 更新镜像采用先上传六个安装资产和独立镜像清单、复核 SHA-256、最后原子替换镜像端 `latest.json` 的顺序；失败时执行有边界的回滚。
- 公开后的补偿只把目标版本从 `latest` 移除并按快照精确恢复两仓此前的 `latest`；不会把已经可能被客户端观察到的 Release 改回 draft，也不会删除或覆盖资产。此时版本号视为永久烧毁，重新发布必须使用新的 patch 版本。
- 企业服务器在公网验收后仍保留 root-only 回滚快照；只有正式仓、镜像、兼容仓依次公开并全部复核后才写入不可逆 finalization receipt 并回收快照。任一公开阶段失败时，只有所有已经变更的公开端点都已证明恢复，才回滚企业服务器；公开补偿不确定时保留新服务器与未 finalize 的事务证据，转人工处置，避免“新客户端、旧服务器”的反向半发布。

`publish/postgres-durable-workflow` 明确不属于 1.9.14：该探索分支以 1.10.1 为基线，包含约 4.4k 行后续架构代码，但尚无 one-click worker service、真实 PostgreSQL 迁移与断电端到端验收，且其探索记录仍说明外部副作用未覆盖。本版本不合并该分支。

## 发布门禁

- `npm run doctor`、集成基线、边界和源码体积检查
- 依赖安全、E2EE 对抗与发布授权检查
- 全量 lint、typecheck、build、测试和 1.9.13 → 1.9.14 升级验收
- SQLCipher 与 Otto Native 架构、提交、哈希、来源证明和运行时探测
- 安装包内容、大小、更新清单和 `SHA256SUMS` 校验
- 正式发布时的 Windows Authenticode、macOS Developer ID/公证、企业 Ed25519 包签名及 License 信任锚校验

## 当前发布状态

目前没有 Windows 签名证书和 macOS Developer ID/公证凭据。因此现阶段只允许生成明确标记的 unsigned transition 草稿/预发布测试件：它不会进入自动更新镜像，不会同步到老仓库，不会部署企业服务器，也不能作为稳定版交付给普通用户。

生产服务器和老用户更新入口必须继续保持已发布稳定版本，直到签名和部署凭据齐备并通过上述全部门禁。
