# 拼车修复最终自查（第 2 轮）

**代码修复结论：通过本轮已确认缺陷的自动化验证，可本地提交。未关闭的已复现拼车内部缺陷：0 项。此结论不等于完整产品或上线验收通过。**

用户最后明确收窄交付范围：**不需要真机验收，完成代码修改并本地提交**。因此真机、真实地图、Windows、正式部署与运营签认不再作为本轮代码交付的阻塞项；未执行项目仍如实保留，不标成通过。

## 修复内容

1. 路由未知异常不再直接返回内部 `Error.message`；已知业务错误保持受控提示。原 3 项路由测试在接手基线已通过，本轮没有虚构“修复三个失败”；增加至 28 项明确参数/身份/全部匿名入口/未知错误断言，真实 HTTP 补签名、版本、删除本人及内部错误回归。
2. Native 测试定位相对文件，支持 `.exe`，缺少可执行文件给出构建诊断；不通过跳过或假 Native 绕过。
3. 三阶段开关在所有环境缺省关闭；服务、workflow、transport、health 共用启动配置快照。显式园区试点名单与协议支持、地图/设备依赖分开。暂停/非试点不返回新候选，也不允许通过他人路线预览继续发现；历史、停止和退出保留。
4. worker 增加所有者原子续租、从请求开始计算 TTL、到期取消与停止取消。后台维护不污染前台候选指标，通知按稳定 ID 事务去重；慢数据库读取后失租不再写候选副作用。
5. 地图 null/坏响应、转换坐标、网络错误、限流、超时和无路线返回受控失败，不生成假数据。
6. 原有暂停写入仍可读历史、企业私聊独立启动、布局一次性迁移修复已存在于 `1fca182e`，本轮补验并保持，没有重写原私聊业务。

## 本轮真实证据

| 层级/检查 | 结果 | 证据 |
|---|---|---|
| 拼车服务端完整专项 | 18 文件 137 通过，无失败/跳过；真实临时 SQLite、PostgreSQL、HTTP、Native，地图 fixture | [最终服务端](evidence/repair-pass-2-server-final-rerun.log) |
| Native 在 server workspace cwd | 6 通过、无跳过；真实 Native | [workspace](evidence/repair-pass-2-native-workspace-final.log)；根目录亦包含于最终服务端，并有 [独立 root](evidence/repair-pass-2-native-root-green.log) |
| 桌面拼车及启动/布局 | 9 文件 47 通过；React/JSDOM、真实 SQLite/Native，非完整登录 IPC | [桌面](evidence/repair-pass-2-desktop-final.log) |
| 原桌面回归 | 10 文件 185 通过；原消息、布局、E2EE/MLS、客户端等 | [原回归](evidence/repair-pass-2-desktop-regression.log) |
| 联邦联系人/协议专项 | 3 文件 9 通过；单独补跑真实存在的文件，未把无匹配 selector 当测试 | [联邦](evidence/repair-pass-2-federation-regression.log) |
| SharedCache/基础设施回归 | 3 文件 9 通过，含所有者 Lua 续租 | [共享基础设施](evidence/repair-pass-2-shared-state-regression.log) |
| Rust MLS | 23 通过、0 失败/忽略、4 个非 MLS 测试被命令过滤；真实 Rust 测试，不是 TS prehook | [Rust](evidence/repair-pass-2-native-rust.log) |
| 隔离 Electron | 实际 Electron、macOS safeStorage、签名 HTTP、Native 加密收发通过；身份/地图/IPC 为显式隔离测试配置 | [Electron](evidence/repair-pass-2-electron.log) |
| 正常 App | 标准企业服务器启动、一次性本地签名测试许可证、SQLCipher、实际 main/preload/App、一个账号登录通过；创建 3 企业测试账号不等于 3 人旅程完成 | [正常登录](evidence/repair-pass-2-normal-app-registered.log)；[截图](evidence/repair-pass-2-normal-app-registered-initial.png) |
| 真实地图 | 未执行；缺 `OTTO_AMAP_WEB_SERVICE_KEY`；可执行公共杭州点位探针已提供 | [缺配置](evidence/repair-pass-2-live-map.log) |
| 类型检查/构建 | server、desktop 均退出 0 | [服务端类型](evidence/repair-pass-2-server-types-final.log)、[桌面类型](evidence/repair-pass-2-desktop-types-final.log)、[服务端构建](evidence/repair-pass-2-server-build-final.log)、[桌面构建](evidence/repair-pass-2-desktop-build-final.log) |
| ESLint | 41 个本轮 TS/TSX 文件通过；2 个新脚本另用 `--no-ignore` 通过。首次把忽略脚本加入统一检查的退出 1 已保留 | [TS lint](evidence/repair-pass-2-lint-final-rerun.log)、[脚本 lint](evidence/repair-pass-2-script-lint-rerun.log) |
| Git 空白检查 | 产品代码暂存差异退出0；全暂存差异退出2，仅4份原始红测日志10处测试输出尾空格，保留原始证据未清洗 | [代码](evidence/repair-pass-2-staged-code-diff-check.log)、[原始日志空白](evidence/repair-pass-2-staged-all-diff-check.log) |
| code-map 生成/校验 | 均退出 0 | [生成](evidence/repair-pass-2-code-map.log)、[校验](evidence/repair-pass-2-code-map-check.log) |
| boundaries | 退出 1：既有 `policyIntelligencePresentation.test.ts` 导入 server 深路径。本轮未修改该文件，未放宽边界规则 | [边界](evidence/repair-pass-2-boundaries.log) |
| doctor | 本工作目录通过；原 `otto-new` 79.81 MB / 50 MB 超限（版本也不同），未删原 Native/证据凑预算 | [本目录](evidence/repair-pass-2-doctor.log)、[原目录](evidence/repair-pass-2-original-doctor.log) |

测试数字分套报告，存在重叠，不把它们相加成不重复验收项数量。历史红测、初次构建/路径失败保留；最终绿测有独立文件。所有新证据使用 `repair-pass-2-` 前缀。

## 最后一轮 9 问

1. 原三项路由接手时已通过；28 项路由＋真实 HTTP 回归补齐，未删除身份/签名/版本断言，见 route-baseline、route-red、route-green 及最终服务端。
2. 两个 cwd Native 都通过 6 项；根目录使用真实 PostgreSQL 的最终全套无 skip。
3. 两种服务器 composition 都注入同一配置模块快照，health 读取同一快照；双数据库开关/历史测试通过。桌面能区分发布可用性和既有状态；未声称对两种完整部署都完成全部 UI 实机验证。
4. 三阶段已走 React→真实数据库→Native，以及真实数据库 Service/HTTP 流程；Transport 测试包含新成员无法解密旧代次、离开者旧密钥/接口重放拒绝和具体消息内容，不只检查人数。正常 App 三阶段真实地图旅程未走完。
5. PostgreSQL 在专用临时实例执行，全套无跳过；Windows、真实地图与真实系统定位没有被填绿。
6. 隔离 Electron 和正常 App 登录分别报告；本地一次性测试许可证不代表生产许可证/供应商许可。用户已明确不要求继续真机验收。
7. 五份当前报告已重写并归档旧版本；367+17 编号保留、无重复，原文去除 checkbox 标记后逐行一致。矩阵非绿行的测试是相关证据，明确不足以整行验收。
8. 本轮发现的异常泄露、路径、配置、租约/候选副作用与地图错误已修复复测。独立 reviewer 复核无新的明确内部阻断。续租与通知幂等不等于跨系统全局 exactly-once：合作式取消不能撤回已发地图请求或已提交事务，未实现数据库 fencing token。
9. 本轮开始 HEAD 为 `cecf75a1`，分支 `codex/blue-heron-7f3a9c`，开始时本工作目录干净。随后其他任务在同目录产生跳蚤市场等修改；本轮只提交拼车文件及共享文件中的拼车 hunk，不包含其他任务新增 hunk。测试运行于此共享工作目录，不声称是所有未提交工作都已验收。 无 push、合并、生产配置修改、生产数据库连接或真实员工测试消息。

## 仍未验证／不在最新范围内

正常 App 三人发布/请求/聊天/邀请/入组/转交/退出完整操作、所有模块移除与状态入口组合、系统通知偏好及点击、所有键盘/读屏/缩放、真实高德/定位、Windows、跨节点故障和园区负载、正式数据库备份恢复演练及运营签认。它们不阻塞用户此次“代码修改并本地提交”，但不能据此宣告完整上线条件已满足。详见 [矩阵](acceptance-matrix.md)、[后续清单](live-acceptance-checklist.md) 和 [部署回退](deployment-and-rollback.md)。
