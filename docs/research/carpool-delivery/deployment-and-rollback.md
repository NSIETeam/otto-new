# 拼车配置、升级与回退（当前代码）

**本轮仅代码修改与本地 Git 提交，不执行生产部署。用户不要求本轮真机验收；以下仍是将来开启前的条件。** 三阶段实现存在，不能因开关关闭而称未实现，也不能因代码存在自动开启。

## 启用

| 配置 | 缺省 | 作用 |
|---|---|---|
| `OTTO_PARK_CARPOOL_REQUESTS_ENABLED` | false | 发布/新请求及新通信写入门禁 |
| `OTTO_PARK_CARPOOL_INVITATIONS_ENABLED` | false | 依赖 requests，允许两人邀请 |
| `OTTO_PARK_CARPOOL_GROUPS_ENABLED` | false | 依赖 requests+invitations，允许多人组 |
| `OTTO_PARK_CARPOOL_PILOT_PARK_IDS` | 未指定 | 指定逗号分隔真实 park ID 限制单园区试点；未指定且显式开启则所有合资格园区，不是自动单园区 |
| `OTTO_AMAP_WEB_SERVICE_KEY` | 未配置 | 服务端真实地图；不得写 renderer 或日志 |

布尔仅接受 true/false/1/0，其他值启动报具体配置名。错误园区列表、越界数值失败可诊断，不静默放行。两个服务器都在启动读取配置快照，改配置需重启全部实例。设备批准、企业/账号有效与真实园区绑定独立校验，打开开关不越过授权。

单园区示例只展示配置，不在本轮执行：requests=true；首阶段 invitations=false/groups=false；试点名单=经管理员确认的一个实际园区 ID。阶段二再开 invitations，阶段三才开 groups；每次确认依赖和历史访问，不能先全开后验收。

## 数值和保留

最低个人重合度 `OTTO_PARK_CARPOOL_MINIMUM_OVERLAP` 0.35；司机 `OTTO_PARK_CARPOOL_DRIVER_MINIMUM_OVERLAP` 0.35；叫车最低成员 `OTTO_PARK_CARPOOL_TAXI_MINIMUM_OVERLAP` 0.35；`OTTO_PARK_CARPOOL_MAXIMUM_DETOUR_SECONDS` 600；`OTTO_PARK_CARPOOL_MAX_TAXI_MEMBERS` 4（范围2–4）；私家车乘客容量由司机选择1/2/3。

`OTTO_PARK_CARPOOL_REQUEST_LIMIT_PER_HOUR` 10；`OTTO_PARK_CARPOOL_COOLDOWN_MINUTES` 30；`OTTO_PARK_CARPOOL_STALE_MINUTES` 120；`OTTO_PARK_CARPOOL_PAUSE_MINUTES` 360；`OTTO_PARK_CARPOOL_POSITION_RETENTION_HOURS` 24（1–168）；`OTTO_PARK_CARPOOL_COMMUNICATION_RETENTION_DAYS` 30（1–90）。这些是工程缺省，不代表合规签认。位置清理与通信清理使用同一配置快照，停业务不应停清理。

## 初始化、监测和停止

正常企业服务器启动加载 carpool schema；SQLite contributor 和 PostgreSQL migrations 使用现有迁移机制，精确字段需加密密钥托管。上线前保存数据库、加密密钥/设备状态的可恢复备份，先在测试副本验证升级；本轮没有操作生产或验证生产恢复。

maintenance 通过现有 RecurringTaskRegistry 启动，每分钟运行；集群 Redis 租约 120 秒，40 秒续租，停止函数取消活动任务并注销周期任务。关注配置错误、地图失败率/时长、候选数量、请求/邀请接受率、成组率、租约丢失及清理滞后；指标不保留精确坐标，后台维护不灌入前台候选样本。失租合作式取消不等于数据库跨系统 fencing。

## 回退

先把 groups=false 阻止新的多人动作，保留既有群的历史和允许的退出管理；必要时 invitations=false，再 requests=false 暂停全部新增。同步配置并重启每个实例，确认请求拒绝、本人历史仍可读、停止/退组可用；暂时地图故障不应删除组或会话。

不要为回退删除表、恢复旧群成员代次、把旧密钥分给新成员、截断加密历史，或撤销 Native 隔离。优先保留理解新 schema 的版本并关新写入；若必须回退到不能理解新 schema 的旧二进制，先另行评审并演练恢复，不能直接覆盖数据库。本轮没有执行回退演练。

完整真实地图/定位/目标平台、供应商缓存和衍生许可、保留周期、阈值与人数、举报责任人、身份失效处置尚需相应负责人确认，见 [剩余清单](live-acceptance-checklist.md)。
