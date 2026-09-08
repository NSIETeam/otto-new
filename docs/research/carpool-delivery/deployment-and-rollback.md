# 部署与回滚说明（仅文档，未执行部署）

三个阶段已实现本地业务链路；生产开通必须单独通过以下门禁。本次只提交本地 Git，不推送、不生成正式安装包、不改变生产配置或数据库。

## 环境与准备

使用仓库锁文件、Node >=22.16、Rust toolchain 文件指定的 1.97.1。先构建 `@otto/native` SDK、core、workflow、server、desktop；Native 除 ping 外必须通过 `park_mls.inspect` 探测，旧的仅支持企业二人 MLS 的二进制不能随新桌面发布。

`node scripts/otto-native-runtime.mjs build --target darwin-arm64 --probe` 已在本机完成。Windows 及其他目标架构仍需各自编译/探测/签名/安装包验收，不能将本机 ARM64 二进制用于它们。本地测试的原生产物未纳入源代码提交。

配置与默认值见 [设计决策](design-decisions.md)。服务端保管 `OTTO_AMAP_WEB_SERVICE_KEY`，沿用 `OTTO_PARK_CARPOOL_MINIMUM_OVERLAP`。密钥不得进桌面、日志或版本库。请求、邀请、多人开关在代码中默认 true，但部署方应在验收前显式设为 false：

```
OTTO_PARK_CARPOOL_REQUESTS_ENABLED=false
OTTO_PARK_CARPOOL_INVITATIONS_ENABLED=false
OTTO_PARK_CARPOOL_GROUPS_ENABLED=false
```

这些开关只限制后续沟通能力；基础 `park_carpool_v1` 沿用现有园区服务许可及地图配置。不能把关开关当成完整交付或数据库回滚。发布前核验同一部署所有节点、桌面版本、设备注册及批准状态一致，确认请求/MLS→邀请→多人能力依赖关系。

## 数据库与维护

1. 用部署所用加密数据库运行时进行备份，并验证备份可恢复及字段加密密钥可用。不要将测试 SQLite 成功等同 SQLCipher 整机验收。
2. SQLite schema contributor 对旧意向表增补 version，创建加密 publications 与 workflow 表；不删除旧表或重写其他模块数据。
3. PostgreSQL migration 15 `park-carpool-workflow-authority` 创建 workflow 授权表，意向及回执沿用 `enterprise_business_records`。真实临时 PostgreSQL 17 已执行迁移与契约；PostgreSQL 14 曾在既有迁移语法处失败，不列为已验证版本。
4. 标准与集群入口均启动 60 秒维护任务；集群用共享 cache 租约。验收清理任务的调度、失败告警、重复执行、进程退出与租约释放。单进程集成测试已通过，多生产节点故障切换尚未实测。
5. 位置/回执到期后默认 24 小时删除，沟通默认 30 天；用户主动删除与身份迁移也清理对应事实。运营、安全须正式批准期限、举报接收处理责任和最小证据口径。

本地 PostgreSQL 测试：设置 `OTTO_CARPOOL_POSTGRES_TEST=1`，必要时设置 `OTTO_CARPOOL_POSTGRES_BIN` 指向 PostgreSQL 17 bin；测试创建临时数据库及 Unix socket，无对外 TCP 监听，结束关闭并清理测试目录。

## 开通门禁

- 获授权的高德测试密钥、缓存/衍生路线及展示许可；代表园区道路、立交、相邻平行道路、上下车绕行准确率和计费成本验收。
- 正式测试企业/园区账号及许可的完整 App 登录流程、设备审批/撤销/换机/长期离线测试。
- macOS 与 Windows 定位允许/拒绝/系统设置恢复，OS 安全存储和打包用途声明验证。
- SQLCipher 实际部署迁移、加密备份恢复；PostgreSQL 集群多节点、容量并发、故障切换与保留任务验证。
- 代表规模下的园区聚合内存、候选分页、地图请求量与延迟。两库 205 候选、30 组跨批测试是正确性证据，不是性能容量承诺。
- 管理员集合点/举报处理演练、运营指标口径签收，明确 App 完全退出不产生本机 OS 通知。

全部满足后才按请求/邀请/多人依赖逐项开启，观察错误率与服务端业务事实。不在本文或本次工作中执行该操作。

## 回滚

先停止新拼车写操作并留存加密备份，再协调服务端、桌面与 Native 版本一起回退；不要滚动混用不理解 workflow/generation 的旧版本继续写入。关闭能力不会自动删除已授权聊天历史，若发生安全事件需要另行停用对应服务入口。

优先回退本次代码提交并保留新增表和列，不直接 DROP 表。旧版并发保护、通信及保留行为不足，因此回退后基础拼车写入也应保持停用，直到明确的数据恢复与保留方案完成。不得用旧版重建消息密钥或声称可恢复已经按期限删除的历史。

数据库恢复需要同时处理身份、意向、workflow、发布回执与字段加密密钥的一致时间点；保留审计记录。已撤销成员不得因为恢复旧快照重新获得授权。生产备份/回滚演练本次未执行。
