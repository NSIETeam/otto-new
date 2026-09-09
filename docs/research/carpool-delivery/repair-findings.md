# 拼车修复缺陷台账（最终代码交付）

已复现且未关闭的拼车内部缺陷：**0**。用户最后明确不要求真机验收；现场/供应商/目标平台未测不被改标为通过，转为本轮范围外。完整结果见 [最终自查](final-self-review.md)。

所有命令默认 cwd 为本仓库根目录，下面日志前缀均 `evidence/repair-pass-2-`。PG使用专用临时实例，不连接生产。原始失败和绿色重跑均保留。

| 编号/严重性 | 前提、预期与实际/根因 | 修复文件 | 红→绿证据与状态 |
|---|---|---|---|
| R01a 历史测试风险 | 原提示词称三路由mock缺导出；接手cecf75a1已有修复，实际3/3通过 | parkCarpoolRoutes.test.ts 仅增强精确参数/身份/匿名入口，不改正确适配器 | route-baseline.log；最终服务端28路由。已验证既有修复，不伪造重复修复 |
| R01b P1 | 任意内部Error可流入HTTP响应；期望未知异常不泄漏内部标记，红测2失败26通过 | parkCarpoolHttp.ts、parkCarpoolHttpErrors.ts、路由/真实HTTP集成测试 | route-red.log → route-green.log 29通过；最终服务端再次通过。已关闭 |
| R02 P2 | Native使用cwd相对路径，workspace找错binary；期望两cwd真实子进程均运行 | parkCarpoolTestSupport.ts、Transport集成、desktop main/park-carpool-test-support.ts及3调用点 | native-workspace-red.log → native-root-green.log + native-workspace-final.log 各6通过。已关闭；Windows文件名支持不等于Windows实测 |
| R03 P1 | 未显式确认却默认启用、动态env与初始化快照混用、非试点仍可发现候选 | Config、Service、Workflow、Transport、Domain、两库Retention接缝、两种composition及desktop可用性 | config-red/pilot-red/review-red → config-http、review-green与最终137通过。显式注入测试配置，不恢复不安全默认。已关闭 |
| R04 验证边界 | 组件/隔离Electron不能证明正常App与真地图；先尝试正常启动被注册门禁拒绝，改用标准start＋一次性本地签名许可证后登录通过 | 新增 normal-app-smoke.mjs、live-map.mjs；保留隔离electron脚本原语义 | normal-app-login.log为早期阻塞；normal-app-registered.log登录通过但三阶段false；live-map.log缺key。用户取消真机验收，范围外项如实列出 |
| R05 P2 | 原目录与分支报告结论不一；旧矩阵对复合条目笼统“本地通过” | 五份报告全文重写、history快照、非列表追踪与矩阵核对 | matrix-audit.json：367+17无重复/原文差异；非绿行不以相关测试冒充整行验收。已关闭报告矛盾 |
| R06 P2 | >120秒任务无续租；失租后候选统计/通知可能继续；延迟121秒acquire成功响应已失效却开工 | Runtime、SharedCache原子renew、Service/Workflow AbortSignal、maintenance不采前台指标 | worker-red、review-red、maintenance-metrics-red → worker-cancellation-green、review-green、maintenance-metrics-green与最终套件。已关闭；不宣称跨系统exactly-once |
| R07 P2 | Provider null/坏坐标/静态图网络错误泄漏TypeError或内部细节，期望受控失败 | amapParkCarpoolProvider.ts 与11项故障/契约测试 | map-red.log → map-green.log 11通过，最终服务端通过。已关闭，真实高德未测 |

## 重放入口

```bash
./node_modules/.bin/vitest run --config packages/server/vitest.config.ts packages/server/src/enterprise/parkCarpoolRoutes.test.ts
OTTO_CARPOOL_POSTGRES_TEST=1 ./node_modules/.bin/vitest run --config packages/server/vitest.config.ts packages/server/src/modules/park_carpool packages/server/src/enterprise/parkCarpoolRoutes.test.ts
```

Native另从 `packages/server` cwd：`OTTO_CARPOOL_POSTGRES_TEST=1 ../../node_modules/.bin/vitest run --config vitest.config.ts src/modules/park_carpool/parkCarpoolTransport.integration.test.ts`。缺二进制先执行 `cargo build --manifest-path otto-native/Cargo.toml --bin otto-native`（root cwd），不能skip。

## 独立已确认修复与非本次问题

暂停写入仍可读历史、企业私聊启动不等待拼车、一次性布局恢复在既有1fca182e，本轮桌面47专项/185原回归补验，不重写这些代码。独立reviewer确认R06合作式取消及稳定通知ID符合本地证据边界，未发现新的明确内部阻断；不能撤回已发地图请求/已提交事务，未实现数据库fencing token。

B01：本目录doctor通过；原otto-new当前79.81MB超50MB，版本/Native/其他业务不同，未删除其他人资产或抬预算。B02：政策模块测试既有跨包深导入使boundaries退出1，`boundary-attribution.json`证明与起始HEAD相同；不是本轮新增，不擅改其他模块。共享目录市场代码也未计入本次本地提交。
