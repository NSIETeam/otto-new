# 园区跳蚤市场缺陷台账 — 修复交付

当前范围按用户最新指示：完成代码和自动化验证，不再启动 App 或进行真机验收。工作分支 `codex/blue-heron-7f3a9c`，不推送。

早期 FM-001–FM-024 与原始结果完整保存在[历史台账](flea-market-evidence/history/20260908-201201/2026-09-08-park-flea-market-bugs.md)，其阶段描述不代表当前状态。原“跨企业仅文字”限制已由本轮附件实现替代；旧 App 探针不作为通过证据。

|编号|问题/根因|最终修改|证据文件（统一前缀 repair-pass-2-）|结论|
|---|---|---|---|---|
|FMR-01|缺索引时全量解密，旧数据回填无请求预算|移除 fallback；持久版本队列和分批回填、独立园区密钥轮换、稀疏 posting 主键查询、精确子串与实时授权复核|search-green、key-isolation-green、server-verified|代码已修复|
|FMR-02|旧容量脚本无失败断言、数据和查询分布过窄|100000历史/10000活跃、500卖家20企业、10场景40组；P95≤1000ms硬断言，最高518.49ms；另测100独立会话|capacity-posting、chat-concurrency-crypto；失败三轮保留|自动化已补齐；网络首屏不在本轮范围|
|FMR-03|新跨企业会话缺少加密附件|接受后6×10MB；原有加密/MLS、签名上传读取、原子绑定、丢响应重试、额度、崩溃上传意图及本地孤儿密文清理|attachment-crash-green、device-matrix、local-orphan-green、desktop-serial-final|代码已补齐|
|FMR-04|新增/撤销设备及旧附件无矩阵证据|SQLite/PG×信封/native MLS；未批准拒绝、批准后无旧密钥、撤销拒绝、丢状态新代际恢复|device-matrix、integration-verified|自动化已补齐；设备授权状态使用fixture|
|FMR-05|组合根 ready 固定 false；正常登录轮询401使会话失效|显式隔离本地 readiness 和真实探针、PG本地数据目录校验、worker幂等启停；补精确成员路由认证|readiness-green、startup-session-red、chat-http-session-green、worker-lifecycle-green|代码已修复；生产仍关闭|
|FMR-06|竞态证据不足、后台批次无上限、保留政策未确认|双库事务屏障续期/撤权/租约/举报冻结；持久游标、分批图片清理、双worker及180天证据回归|race-matrix、image-budget-green、server-verified|代码修复与自动化通过；法律保全/备份政策待确认|
|FMR-07|旧报告混淆阶段结果、局部测试及完整验收|旧报告与失败证据归档；Task0–9和47条F/A逐项映射，撤回错误App登录判定|本报告、自查报告、执行日志、技术决策|报告已纠正|

本轮补充发现并修复：上传文件写入后崩溃留下不可追踪孤儿（持久 upload intent）；客户端确认发送/确定拒绝后密文暂存残留（删除与24小时中断清扫）；旧 worker 停止函数关闭新 worker（生命周期实例隔离）；热门 posting 顺序与稀疏候选查询超时（排序索引和≤200候选主键查询）。各有失败→通过日志，未修改阈值掩盖性能失败。

未执行项目：完整 App/系统保存对话框/协议链接/macOS与Windows安装包、20Mbps与100ms RTT下首批可操作时间、真实S3服务；不标记通过。法律保全、最小记录和备份最终策略没有获批，保留为生产上线条件，未擅自发明策略。
