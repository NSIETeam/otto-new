# 1.9.15 单园区地图/拼车配置事务 — 待独立审核

此实现尚未访问生产，也尚未运行真实 Linux systemd 验收。**不能把本地测试通过称作配置已生效。**

## 文件与使用边界

- `carpool-config-activation.py`：仅接受固定生产路径的 `--apply` 执行器。无 resume、自动重放、主机重启、数据库写入、网关事务改写或旧业务包部署。
- `carpool-config-transaction-draft.py`：冻结依赖，SHA256 `8c954109ddae2e08417b0cec4f95bcf43dc4555ffa318f88790224a9da050ddf`，保持原文件字节不动。新执行器在私有导入实例替换为带运行中 stdout/stderr 双限额和读前/后 fstat 的加强原语。
- `carpool-config-activation.test.py`：25 个本地测试函数，另含 15 个持久化步骤中断、错误停机/后代、篡改身份、模糊 rename/fsync 等子场景。真实子进程测试只运行本机 Python fixture。
- `carpool-config-systemd-fixture.py`：仅允许 GitHub-hosted 临时 Linux，拒绝 `/etc/otto-enterprise` 或 `/var/lib/otto-ci-deploy` 存在的机器。随机 nonce systemd 服务和 `/run` 内配置，不使用生产凭据。
- `carpool-config-systemd-workflow.yml`：待审核独立诊断分支工作流，不是正式发布流程，不应合入冻结的 1.9.15 业务代码。

实际事务顺序：双非阻塞锁 → 完整预检与私有副本 → stop old → 确认 MainPID/ControlPID=0、已知 unit、固定 cgroup 及全部后代为空（两次）→ 同文件系统原子替换 → start → 新 InvocationID/PID/实际 environ、真实 private health/public capabilities/park overview → 成功回执。

失败后的自动恢复仅是**同一个 1.9.15 发布目录的旧配置恢复**。候选必须先被停止且后代全空，再还原 exact old.env；不声称该事务回退到 1.9.14。stop 超时、单位未知、配置字节未知、候选后代仍存活、恢复失败都保留 `recovery-required`，没有第二次猜测性修改。进程中断保留最后一个 fsync 后的阶段文件，操作员必须独立核对，不支持重复运行覆盖。

## 独立验收输入（根目录 0600，不伪造）

固定 bootstrap：`/root/otto-gateway-bootstrap-1.9.15-20260909`。

正式 release 已经通过 canary、迁移、健康验收之后，操作员先保存：

1. `verified-release-1.9.15.json`：schema `otto-verified-release-read-only-v1`；准确的 `sourceCommit` 与 `runtimeBuildCommit`（不可互换）；`version=1.9.15`、`schemaVersion=26`；真实 `upgradeAccepted/canaryAccepted/productionHealthy=true`。其独立来源不得仅是本配置执行器的输出。
2. `carpool-recovery-1.9.14.env`：从已验证恢复包保全的旧版 exact env，不得用更新后的 1.9.15 env 冒充。内部版本必须 1.9.14，build `1376fba9d2f1eac0a6f50825c2ca001c691c253c`。
3. `carpool-recovery-1.9.14-deploy.tar.gz`：独立保全的旧部署工具档案。
4. `carpool-recovery-1.9.14.json`：schema `otto-preserved-1.9.14-recovery-v1`，上述版本/build 与两个文件的 `environmentSha256/deployArchiveSha256`；实际 `restoreDrillPassed=true`、`gatewayTransactionUnmodified=true`。执行器只校验/保全这些资产，**不修改 finalized gateway transaction**。
5. 已存在固定 `amap-shared-test-key`：root:root 0600，密钥仅在内存/私有 env 副本，不进入参数、输出或公开产物。
6. `carpool-activation-acceptance.json`：schema `otto-carpool-activation-acceptance-v1`，`releaseAccepted/readOnlyEvidence=true`，`sourceCommit`、`runtimeBuildCommit`、`version=1.9.15`、`schemaVersion=26`、`parkId`、实际 `organizationId`，15 分钟内的整数 `verifiedAtUnix`。绑定 `environmentSha256`、`manifestSha256`、`recoveryReceiptSha256`、`releaseReceiptSha256`，固定三个 `helperSha256`，完整 `boundFilesSha256`（三个网关、unit、实际 Node、common/verify-release/health-check）及准确 `systemctl show` 返回的 `service` 属性对象。

生产 park 候选已由旧版 API 确认是 `park_3fe221e6-e39e-4bc0-a92f-ce03a0f1f9f9`；执行器仍要求新版本新鲜 `organization overview` 实际返回 active 同一园区。禁止把园区名称当 ID，或从旧记录直接推断新版本验收成功。

严格阶段：`requests` 对应 true/false/false；`groups` 对应 true/true/true。只能改变地图 key、三个 flags 与单一 pilot ID。现有不同 pilot、已启用阶段降级、无变化重复执行均拒绝。

## 验收究竟证明什么

启用验收绑定新服务 InvocationID、MainPID、进程实际加载的环境值（全部只做内存比对，不输出值）、真实健康接口的版本/build/schema/SQLCipher/许可证、公开的请求/邀请/群组能力，以及平台管理员只读园区 overview。

这证明**单园区配置已由正确运行实例加载**，不等于成员聊天/群组端到端通过，也不声称这次执行调用了高德。现有 GET `/enterprise/park-carpool` 会执行工作流 reconcile/匹配通知，故没有混入纯只读预检。实际高德 API 与多人 MLS 业务验收使用独立原始回执。

健康检查不盲重试身份/许可/SQLCipher失败。仅 Type=simple 新启动后 TCP 尚未绑定可短暂等待；实际 health 一次执行，并使用总预算的剩余时间。子进程 stdout 与 stderr 各至多 1MiB，运行中就截断终止，不等待内存耗尽才判失败。所有失败输出都是静态文本，不带原始异常、命令、token 或响应体。

## 待 root 审核的诊断流水线

在独立分支 `diagnostics/carpool-config-systemd-20260909` 放置下列文件，不改正式发布分支：

- `.github/workflows/carpool-config-systemd-diagnostic.yml` ← 本地 workflow 模板。
- `scripts/diagnostics/carpool-config/` 下四个 Python 文件：activation、activation.test、systemd-fixture、冻结 draft。
- `.gitattributes` 对**仅这份冻结 draft**声明 `-text`，避免 checkout 的 CRLF/LF 归一化破坏 SHA 锁。

该工作流不引用任何 secrets 或发布环境，权限只有 contents:read；actions 固定提交。`unshare --net` 只隔离测试控制器，不代表 systemd 启动的新服务继承该 namespace；因此每个测试 unit 自身另设 `PrivateNetwork=yes` 和 `NoNewPrivileges=yes`。系统服务 fixture 自身也不使用网络。真实 Linux 计划覆盖成功、候选 health 拒绝、exit7、rename 前/后不确定性、旧 stop 实际超时、真实后代清理、所有正常/恢复阶段中断，以及两把独立 flock 争用。

必须先审核再推送，保留真实 CI receipt。若任何 systemd fixture 失败，不把本地 25 项替代为 Linux 验收。无论成功与否，receipt 标识 `productHealthIsFixture=true`、`productionDeploymentAcceptance=false`，不能冒称正式企业全链路。
