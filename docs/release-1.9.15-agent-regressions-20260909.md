# Otto 1.9.15 Agent 回归修复记录

日期：2026-09-09。候选基线：`c8ef4a32930e86c2f8d53ddc43c255f283d3b134`，其后为本次未提交整合差异。范围：本地候选源码与隔离测试；不代表已发布、已完成安装验收或真实模型评测。

## 旧失败、修复与安全边界

旧失败索引：`D:/otto/agent-publish-validation-20260908/evals.json`。

| 旧失败 | 查明原因与最小修复 | 保留的反向断言 |
| --- | --- | --- |
| adversarial-graph 部分迭代不能完成 | 旧测试缺少新恢复门控要求的精确 failureFingerprint；补全对应证据并显式解决恢复项，未改生产图门控 | 无关证据、未解决恢复项不能交付；512 种组合全覆盖 |
| 读文件被归类为 external/change | 原始整句正则把路径中的 publish/push/upload 当动作；意图识别先掩蔽资源操作数，保留真实动作和产物扩展名 | Windows/POSIX/URL/带空格路径不误触发；真实发布部署、删除全部及紧邻路径的动作仍走高风险门控 |
| 同文档生成被确认门控阻止 | 同一意图分类缺陷；固定临时目录前缀，使反例不依赖运行机器路径 | 读任务完成，PPT ZIP 确有指定内容；混入 shell 写操作和伪验收时整轮仍为 incomplete |
| restart-unknown-outcome 未到真实 crash 点 | Windows 恢复文件原子替换曾报 EPERM，流程在外发前即进入对账；只对同一临时文件 rename 的 EPERM/EACCES/EBUSY 做最多 5 次有限重试 | 持续失败保留旧 started 记录并要求对账；ENOSPC 不重试；不重放外部发送、不先删除旧记录 |

失败先于修复：意图路径反例初始 9 项失败，追加紧邻动作 2 项失败；恢复存储新增 5 项先失败。修复后对应单测为 28/28、14/14。工具权限、确认和真实验收要求均未放宽。

主要修改：`turnControlPolicy.ts/.test.ts`、`turnRecoveryStore.ts/.test.ts`、`agent-runtime-adversarial.scenario.test.ts`、`safetyLiveness.scenario.test.ts` 与专用测试配置。

## 已执行验证

| 检查 | 结果与源码时间边界 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --config scripts/release-agent-regressions.vitest.config.mjs --maxWorkers 1 --silent` | 01:48:52 开始，5 文件 48/48，38.10 秒；覆盖当时 QR/企业/路径组合生产源码，后续扫码安全修补由渠道最终组合验证记录承接 |
| `node node_modules/vitest/vitest.mjs run --config scripts/release-enterprise-isolation.vitest.config.mjs --maxWorkers 1 --silent` | 01:46:48 开始，12 文件 312/312，239.16 秒，setup 0ms；不继承 fs append 模拟；enterprise HTTP 测试加载早于后续 canary 发送 spy 扩展 |
| 官方渠道运行时安全补测 | 14 个新反例先失败；后续加真实 SDK 接口契约、票据/错误保密测试；WeCom 原始错误泄露反例也先失败；最终 02:05:42 为 24/24 |
| core/server/evals 类型检查 | 均通过；server 类型检查另在官方运行时安全补修后通过 |
| 已改文件 ESLint、`git diff --check`、`npm run code-map:check` | 通过；最终全渠道、桌面类型和构建结果见渠道整合记录 |

专用 Vitest 配置使用候选源码精确 aliases，避免共享依赖链接加载另一 checkout 的旧 dist。

最新真实本地进程重启证据：

- known：`C:/Users/14975/AppData/Local/Temp/otto-real-restart-oQNS3Q/run/controller-evidence`
- unknown：`C:/Users/14975/AppData/Local/Temp/otto-real-restart-AdaaVC/run/controller-evidence`

两者均有 `result.json`、`process-lifecycle.json`、`independent-receiver.json`，实际 kill/restart 后独立本地 HTTP 接收端计数为 1。旧失败曾出现 `interruption-not-reached.json`，未被计作成功重启。

## 伴随整合与限制

- `OTTO_USER_DIR` 覆盖本次 memory/session/skill/endpoint/model-secret/settings/chat-cache 默认消费者；保留显式路径覆盖及新版自动技能命名、草稿审核逻辑。不宣称历史 commands/legacy-migration 等全仓库路径已隔离。
- 企业端点改变会清除旧令牌；Federation 需当前端点已协商且已认证。企业 HTTP 按字节限额，并在完整拼接后解码 UTF-8，修复分块中文损坏。
- 官方运行时握手、取令牌及发送拒绝重定向，响应上限 64 KiB，超时覆盖完整 body。DingTalk 不能把 SDK 已兑现但实际未连接的 Promise 当成功；票据单独编码，WSS 只允许已核验官方主机。固定 SDK 私有 URL 存储槽通过真实包契约测试；依赖升级或新增地区主机需重新审查，变化时拒绝连接。
- 未调用付费模型；模型回复和供应商连接使用合成/模拟输入。真实验证指本地文件产物、隔离 HTTP、持久化以及实际子进程中断恢复，不指真实云模型或真人扫码发送。
- 未导入旧 native 产物，未重放强制 local-workspace 登录绕过。扫码取消/身份切换/安装回滚与依赖 notice 的最终处置另见 `docs/release-integration-1.9.15-audit.md`。

## 候选差异只读检查

在新增本记录之前，检查 HEAD 后 101 个已跟踪改动及 28 个未跟踪文件：未发现新增 dist/build/node_modules 路径、二进制/安装包、source map 或 tsbuildinfo。私钥块、常见云访问密钥、供应商 token 前缀及带凭据 HTTP URL 扫描未命中；较宽的凭据字面量规则仅命中测试文件中的固定合成值。扫描不输出匹配原值，也不替代发布 CI 的秘密扫描与产物验收。

## 1.9.15 依赖安全补修与原例外重验

2026-09-09 在上述组合源码冻结后，仅补修锁文件中两个包的 `version`、`resolved`、`integrity`（共 6 行替换）：`fast-uri 3.1.5 → 3.1.6`、`qs 6.15.3 → 6.16.0`。qs 的最低修复版本是 6.x 内的小版本升级，并非 patch 号。未改 manifest、QR SDK 精确版本、axios 1.20.0、发布门禁或例外策略；未运行整体 `npm audit fix`，未写共享 node_modules 链接。

官方公告核对：fast-uri v3 线最低修复为 3.1.6，涉及 [scheme-relative IDN](https://github.com/advisories/GHSA-5jgf-p345-68v8)、[畸形 IPv6](https://github.com/advisories/GHSA-f65p-4m7j-42xc)、[重复 hostname 解码](https://github.com/advisories/GHSA-fph4-wmhf-6fwf) 和 [编码 scheme](https://github.com/advisories/GHSA-jqff-g426-hqxp)。qs 最低修复为 6.16.0，涉及 [逗号数组限制绕过](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) 和 [isBuffer 非函数属性导致拒绝服务](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)。

- 在 `D:/otto/otto-dependency-patch-lock-20260909` 隔离解析，排除默认更新引入的 fast-uri 3.1.7 和无关 pruning；最终元数据取自官方 registry 的独立精确安装 `D:/otto/otto-dependency-patch-runtime-20260909`。锁中两个完整包条目与该安装锁逐字段一致，现有所有消费者 semver 范围均满足。
- 新增 `scripts/tests/release-dependency-patches.test.js`：通过 `OTTO_DEPENDENCY_PATCH_ROOT` 显式选择隔离真实包；CI 默认检查本次安装。旧包独立安装 `D:/otto/otto-dependency-patch-before-20260909` 得到 7 项 RED、1 项普通输入 PASS；修复包 8/8 PASS。覆盖 3 类 URI 混淆、2 类 qs 恶意输入、正常转换，以及锁文件与实际加载版本一致性；未访问 PoC URL，未使用大内存攻击输入。
- 02:26:14 合并复验为 2 文件 19/19（新增 8 项 + 原审计门禁 11 项），2.84 秒。命令：`node node_modules/vitest/vitest.mjs run --config scripts/tests/vitest.config.ts scripts/tests/release-dependency-patches.test.js scripts/tests/release-dependency-audit.test.js --maxWorkers 1 --testTimeout 20000 --silent`，环境变量指向上述修复包隔离目录。此前原门禁的源码遍历单测冷启动 5.86 秒曾超过默认 5 秒；只在这次命令给出 20 秒上限，未改门禁实现或项目测试配置。ESLint、`git diff --check`、`npm run code-map:check` 均通过。
- **实时全量** `npm run security:dependencies:release`（不 omit dev）成功，仍仅报告 `GHSA-5p2g-fcmc-qvqq`、`GHSA-w3rx-r6r6-pgpr` 对应的 `pptxgenjs@4.0.1 → image-size@1.2.1` 限定例外。最初受限网络调用失败被门禁拒绝；最终为官方 registry 实时请求，不是离线快照。

例外仍属于原 `otto-1.9.14-image-size-unreachable` 审查记录；本次是在 1.9.15 源码上重新验证**同一限定证据**：精确版本和依赖路径、workspace manifest、安装运行时哈希、源码不可达性以及实时 advisory 集合。没有把豁免扩大为其它依赖、其它路径或其它漏洞，也没有延期；有效期仍到 `2026-09-15T00:00:00Z`，到期应按原门禁失败。通过表示满足当前有期限的例外政策，不表示“零漏洞”或替代 clean CI 与最终安装包验收。
