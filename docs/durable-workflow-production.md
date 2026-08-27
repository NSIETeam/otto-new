# PostgreSQL 耐久工作流

## 存储边界

- 桌面端、开发和离线部署继续使用 `FileWorkflowStore`。它只解决单机原子写、修订冲突和进程中断后的保守恢复，不支持多进程或多服务器抢占。
- 企业 PostgreSQL 模式使用 `durable_workflow_*` 表作为唯一权威状态。任务正文、状态、租约、审批、死信、补偿和审计不能回落到本地 JSON。
- Redis 不保存任务权威状态。它可以用于唤醒 Worker，但 PostgreSQL 必须能够在 Redis 丢失后独立恢复队列。

## Worker

独立进程入口：

```bash
otto-enterprise-workflow-worker
```

必须配置：

```text
OTTO_ENTERPRISE_DATABASE_BACKEND=postgresql
OTTO_POSTGRES_URL=postgresql://...
```

可调参数：

| 环境变量                          |       默认值 |                 边界 |
| --------------------------------- | -----------: | -------------------: |
| `OTTO_WORKFLOW_WORKER_ID`         | 主机名与 PID | 1–128 个安全标识字符 |
| `OTTO_WORKFLOW_LEASE_MS`          |        30000 |          1000–600000 |
| `OTTO_WORKFLOW_POLL_MS`           |         1000 |             25–60000 |
| `OTTO_WORKFLOW_CONCURRENCY`       |            2 |                 1–32 |
| `OTTO_WORKFLOW_SHUTDOWN_GRACE_MS` |        10000 |           100–600000 |
| `OTTO_WORKFLOW_RECOVERY_SWEEP_MS` |         5000 |             100–60000 |
| `OTTO_WORKFLOW_HEALTH_HOST`       |    127.0.0.1 |     健康接口监听地址 |
| `OTTO_WORKFLOW_HEALTH_PORT`       |         7781 |              1–65535 |

健康检查为 `GET /health`，只有 Worker 循环仍运行且 PostgreSQL 探测成功时才返回 200，否则返回 503。Worker 进程应由 systemd、容器编排或客户现有进程管理器独立拉起，并设置自动重启。Otto Server 与 Worker 可以位于同一台服务器，但必须是两个进程；Server 重启不应停止已经领取到其他 Worker 的任务。

Worker 只执行编译进发布物且在 `DurableWorkflowTaskRegistry` 中登记的任务类型。未知类型在任何外部操作开始前失败，不允许通过环境变量加载任意 JavaScript 执行器。

## 状态与故障恢复

1. Worker 使用 `FOR UPDATE SKIP LOCKED` 领取一个可运行步骤。
2. 领取事务写入 Worker ID、租约截止时间和随机 fencing token 后才允许执行器启动。
3. 执行期间每个租约周期至少续租三次。旧 Worker 的 token 一旦失效，不能提交迟到结果。
4. 无副作用和幂等步骤在租约过期后按重试预算重新排队。
5. 外部副作用在租约过期或结果不明时进入 `unknown_outcome`，禁止自动重放。
6. 达到最大尝试次数或审批超时后进入死信；任务不会从数据库静默消失。
7. Worker 每次启动先恢复过期租约和审批，再领取新工作，因此进程或服务器重启后可自动继续安全步骤。

## 审批、接管与补偿

管理员页面：

```text
/enterprise/admin/workflows
```

管理员可以：

- 批准仍在有效期内的等待步骤；
- 查看并重试死信；
- 对结果未知的外部步骤记录“确认成功、确认失败或人工取消”；
- 取消未完成任务；
- 对已成功且显式声明补偿的步骤发起逆序补偿。

所有接管、重试、取消和补偿操作必须填写理由。外部步骤只有在管理员明确确认“操作没有发生”时才能从死信重试。运行中的外部步骤收到取消请求时转为 `unknown_outcome`，不能伪装为已经取消成功。

补偿不是数据库回滚。工作流定义必须为每个需要撤销的步骤提供独立、幂等的补偿任务；系统只按成功步骤的逆序调度这些任务。没有显式补偿定义时拒绝发起补偿。

## HTTP API

登录成员可以提交允许列表内的任务并查看自己创建的任务。企业管理员可以查看本企业全部任务并进行人工处理。

创建任务时必须提供租户内唯一的 `submissionIdempotencyKey`。服务端会对标准化后的工作流定义和优先级计算 SHA-256 摘要：同一账号使用同一个键重放同一请求时返回原任务；同键对应不同账号或不同请求内容时返回 409。该提交键用于防止客户端超时重试创建两份工作流，不能用每一步的执行幂等键替代。

- `POST /enterprise/workflows`
- `GET /enterprise/workflows`
- `GET /enterprise/workflows/{runId}`
- `POST /enterprise/workflows/{runId}/steps/{stepId}/approve`
- `POST /enterprise/workflows/{runId}/steps/{stepId}/retry`
- `POST /enterprise/workflows/{runId}/steps/{stepId}/resolve`
- `POST /enterprise/workflows/{runId}/cancel`
- `POST /enterprise/workflows/{runId}/compensate`

API 以 PostgreSQL 元数据和登录账号的企业 ID 做租户隔离，不能依赖 URL 中的任务 ID 判断权限。

输入校验错误返回 400，提交幂等冲突和状态冲突返回 409；数据库或其他内部异常只返回通用 500，不向客户端回显连接串、密码或底层错误消息。

## 当前内置任务

首个版本只内置无外部副作用的 `workflow.condition` 与 `workflow.checkpoint`。业务任务必须逐个实现已审计的执行器，并声明输入上限、副作用类型、幂等键用法、审批策略和补偿逻辑。不能把任意 Shell、模型工具调用或桌面 RPA 直接包装成“可自动恢复”的服务器任务。

因此，本模块完成了生产队列、恢复和人工接管基础设施，但不会自动把历史桌面工作流迁移到服务器。每一种长任务只有在注册了相应服务器执行器并通过故障注入测试后，才算真正具备服务器续跑能力。
