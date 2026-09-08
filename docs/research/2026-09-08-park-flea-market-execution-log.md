# 园区跳蚤市场修复执行日志

用户最新范围：完成代码修改、自动化与本地提交；不进行真机验收，不再启动 App，不推送。执行目录 `/Users/yang/Desktop/otto-carpool-fixed-91bc4e`，分支 `codex/blue-heron-7f3a9c`。起点 cecf75a1，团队中途拼车提交 aac4b677、f7de89e6 保留。

原开发执行日志完整保存在[历史归档](flea-market-evidence/history/20260908-201201/2026-09-08-park-flea-market-execution-log.md)。以下仅描述本轮最终工作；历史失败、误用命令、超时及被取消的 App 探针均保留，不用重复测试累计数字。

|Task|实际完成工作|证据 / 结论|
|---|---|---|
|0|记录分支、HEAD、环境和已有改动，归档旧报告，登记FMR-01–07|baseline.json、server-baseline：29文件103项；原性能两组不能当完整门禁|
|1|删除缺索引全量解密；持久分批回填、密钥隔离/轮换、精确子串、排序及稀疏查询|server-verified、key-isolation-green；双库覆盖|
|2|扩充数据分布和10场景，阈值失败真实非零；100独立会话并发与维护|capacity-posting：40组P95≤1000ms，最高518.49ms；会话用注入传输，网络首屏未执行|
|3|接受后加密附件、流式上传进度、签名读取、原子绑定、重试、额度、服务/本地孤儿清理|server-verified、desktop-serial-final、local-orphan-green、integration-verified|
|4|原会话复用、新批准/未批准/撤销设备、旧历史拒绝、状态恢复|双库×信封/native MLS真实加密4组；设备授权使用fixture|
|5|正常组合根readiness、隔离目录与PG本机限制、worker生命周期、修复启动轮询401|正常 startEnterpriseServer HTTP通过；worker-lifecycle-green；生产保持关闭|
|6|表单、列表、上传重试、消息附件组件/主进程回归|22文件232项；用户取消完整 App/OS/安装包验收，未伪造通过|
|7|双库事务屏障续期/撤权/租约/冻结，图片/报告/列表分批清理与持久游标|8个真实数据库竞态用例；租约与清理并发、随后发布引用与双worker；法律保全政策未确认|
|8|改动文件lint、两端类型/构建、doctor、code-map、边界检查、邻接模块回归|边界检查仅原有政策测试跨层导入失败；其余见下表|
|9|重写技术决策、缺陷台账、执行日志和47行F/A自查，保留失败证据|报告明确代码/自动化/未执行范围；本地提交，不推送|

## 最终命令

服务回归命令见[自查S](2026-09-08-park-flea-market-self-check.md)，38文件183项通过。桌面22文件232项的完整命令：

```sh
npm exec --workspace=packages/desktop -- vitest run --no-file-parallelism src/renderer/components/ParkMarketDialog.test.tsx src/renderer/components/ParkMarketModel.test.ts src/renderer/components/MarketImageViewer.test.tsx src/renderer/components/MarketContactCenter.test.tsx src/renderer/components/MarketAssociatedItems.test.tsx src/renderer/components/MarketNotifications.test.tsx src/main/park-market.test.ts src/main/park-market-links.test.ts src/main/park-market-messaging.test.ts src/main/park-market-uploads.test.ts src/main/park-market-mls.test.ts src/main/enterprise-e2ee.test.ts src/main/enterprise-auth-sync.test.ts src/renderer/components/InboxPage.test.tsx src/main/enterprise-client.test.ts src/main/enterprise-mls.test.ts src/main/enterprise-mls-attachments.test.ts src/main/enterprise-mls-private-messages.test.ts src/renderer/parkMarketMutation.test.ts src/renderer/moduleWorkspace.test.ts src/main/park-carpool-startup.test.ts src/main/park-carpool-chat.integration.test.ts
```

最新修改复核和真实链路：

```sh
npm exec --workspace=packages/desktop -- vitest run src/main/park-market-messaging.test.ts
./node_modules/.bin/vitest run --config packages/server/vitest.config.ts --no-file-parallelism integration/park-market/authenticated-flow.test.ts integration/park-market/encrypted-flow.test.ts
```

分别2项和5项通过。没有设置 `OTTO_MARKET_DESKTOP_FLOW` 或运行 Electron 探针。之前从server workspace执行仓库根integration路径未找到测试，退出1；修正cwd/配置后联合5项通过，两个日志均保留。

容量命令见自查P/Q。cold为数据库重启后第一轮，不是每条场景清空OS缓存；不是HTTP/IPC性能。前3次阈值失败保存容量JSON与非零exit，最终结果为 `repair-pass-2-capacity-1788878807656.json`。桌面并行回归的两个超时保留，随后相同范围串行232项通过，没有放宽超时。

## 工程检查记录

以下日志均位于 `flea-market-evidence/`，统一前缀 `repair-pass-2-`。有exit文件的以其实际退出码为准。

|命令|日志|退出码/结果|
|---|---|---|
|`npm run doctor`|doctor-final.log|0|
|`npm run typecheck --workspace=packages/server`|server-types-verified.log|0|
|`npm run typecheck --workspace=packages/desktop`|desktop-types-verified.log|0（native前置为TS构建，不冒充Rust测试）|
|`npm run build --workspace=packages/server`|server-build-final.log|0|
|`npm run build --workspace=packages/desktop`|desktop-build-verified.log|0|
|`eslint --no-ignore <owned-files.json中50个文件> --max-warnings 0`|lint-final.log，首行完整参数|0|
|`npm run validate:boundaries`|boundaries-final.log|1：既有policyIntelligencePresentation.test.ts跨层导入；HEAD原文已核实|
|`npm run code-map` / `npm run code-map:check`|code-map-final.log / code-map-check-final.log|0 / 0|
|`git diff --check`|diff-final.log|0|

## 证据范围与交接

主进程/真实HTTP/原生加密和双数据库均有自动化，但不以其中任一代替完整App。共有F01–F07、A01–A40共47行，逐项实现路径、命名用例、命令、日志和未验证项见[自查](2026-09-08-park-flea-market-self-check.md)。旧文件和失败日志不删除；每个检查最终结果由相应exit及输出支持。

未执行：完整App/系统保存与协议/双平台安装包、20Mbps+100ms RTT首屏、真实S3；未确认法律保全/最小记录/备份策略。生产开关未开启。并发团队的星图、拼车、package及其它改动未打包进市场提交。

证据日志入库时仅去掉行尾空格和文件末尾多余空行，以通过 Git 空白检查；保留命令输出、失败断言、测试数字和退出码。提交前 doctor 再次通过，见 `repair-pass-2-doctor-precommit.log`。
