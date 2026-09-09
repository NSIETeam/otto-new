# 跳蚤市场修复、性能优化与完整验收提示词

> 交接方式：将本文件完整交给负责开发的 AI。接收开发任务后按下面的计划实际修复、测试并更新报告，不只返回另一份计划。本次编写本文档没有执行业务代码修复。
>
> 可用时读取 `/Users/yang/.agents/skills/superpowers/executing-plans/SKILL.md` 和 `/Users/yang/.agents/skills/superpowers/verification-before-completion/SKILL.md`。业务规则遵循仓库 TDD；先复现，再最小修复，再复测。

## 对你上一阶段工作的批评

**目前的跳蚤市场交付没有达到“完整实现并自查”的要求。你有真实的开发进展，但测试、性能、正式接入和报告收尾都还不合格。**

已经通过的发布、图片、治理、状态管理和真实加密流程值得保留。本轮独立复核也确认了真实 SQLite/PostgreSQL、信封加密和 Native MLS 的部分流程。这不等于整份 PRD 已完成。

以下问题需要你明确纠正：

1. **搜索索引只留下了红测试，实际实现和迁移没有闭合。** SQLite 和 PostgreSQL 都报 `park_market_search_terms` 不存在。开发过程中写红测是正确的，但不能停在这里后就把搜索当作完成。
2. **关键搜索性能远未达标。** 已有容量证据中，“无匹配搜索”的 P95 是 SQLite 75.827 秒、PostgreSQL 33.692 秒，目标为 1 秒。最新列表快不代表搜索快，不能只展示较好看的指标。该数据是之前日志，不冒充本次重跑结果；当前扫描解密实现仍在，需要真实优化和复测。
3. **性能脚本甚至没有把延迟超标变成验收失败。** 当前脚本计算并输出 `passed:false`，但没有对最终性能指标断言。一个退出成功的测试进程，可能仍代表性能完全不合格。你必须修正这种“测试绿、业务红”的验收漏洞。
4. **消息能力存在未闭合部分。** 普通市场会话附件没有完整发送/读取链路；换设备和密钥恢复的可用性也没有完整验证。不能因为文字收发成功，就把 PRD 的全部消息要求打勾。
5. **报告更新不可靠。** 自查报告、缺陷台账和代码已有不同步，例如企业私聊复用已新增代码/测试，旧台账却仍写整套咨询未实现。报告应当帮助接手者定位事实，而不是让人重新猜哪段话有效。
6. **正式应用交付验证仍不足。** 服务层测试、身份 fixture、JSDOM 与真实企业登录、正常 App 的 IPC、双端安装包不是同一层级。没有实际运行证据的部分必须明确标出。

保持生产 `ready=false` 是当前正确的保护措施，**这一点不应被批评为错误**。问题是不能永远靠硬编码关闭代替补完依赖、可控启用和正式入口验收。禁止为了让功能出现就改成无条件 true 或绕过现有 MLS 安全发布闸门。

请停止用“基本完成”“测试都差不多过了”概括交付。接下来按下面的任务把事实、实现、性能和证据对齐。不要贬低已有有效实现，也不要重新做已经验证的业务来回避困难的收尾工作。

## 1. 必须读取的依据

- 仓库：`/Users/yang/Desktop/otto-new`。
- 仓库规则：`/Users/yang/Desktop/otto-new/AGENTS.md` 和实际修改目录适用的 AGENTS.md。
- 产品基线：`/Users/yang/Desktop/otto-new/docs/plans/2026-09-08-park-flea-market-prd.md`，v1.1，包含 F01–F07、A01–A40、字段、权限、时限和非功能要求。
- 原执行计划：`/Users/yang/Desktop/otto-new/docs/plans/2026-09-08-park-flea-market-implementation-plan.md`。
- 原交接：`/Users/yang/Desktop/otto-new/docs/plans/2026-09-08-park-flea-market-ai-handoff-prompt.md`。
- 技术决策：`/Users/yang/Desktop/otto-new/docs/plans/2026-09-08-park-flea-market-technical-decisions.md`。
- 报告：`/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-flea-market-self-check.md`、`/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-flea-market-bugs.md`、`/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-flea-market-execution-log.md`。
- 模块边界：`/Users/yang/Desktop/otto-new/docs/code-map.md`、`/Users/yang/Desktop/otto-new/docs/product-modules.md`、`/Users/yang/Desktop/otto-new/docs/runtime-kernel-boundary.md`。

原计划中的拟定文件名与实际实现有差异，例如实际桌面文件是 ParkMarketDialog.tsx。以当前代码核实接入点，不为了迎合旧路径重建第二套市场。

2026-09-08 独立复核基线：服务端 27 个测试文件，93 通过、2 失败；桌面专项 5 文件 6 项通过；真实加密集成 4 项通过；服务端和桌面类型检查通过。基线不是你的修复后结果，必须重新运行并记录真实计数。

## 2. 执行边界与结果要求

- 本次只补完 PRD 首发，不添加支付、订单、评价、库存、跨园区、扫码传图、AI 发布或求购。
- 工作区有其他 AI 正在修改拼车、Native、共享数据库迁移和桌面接入。先记录当前状态，不 reset/clean/stash，不自动 pull，不覆盖他人修改，不把整个目录一起提交。
- 不 push、合并、生产部署、改生产配置或向真实用户发测试消息。使用专用本地账号、临时数据库、测试对象存储。
- 普通可逆开发选择自行推进；仅遇实质 PRD/安全策略冲突或缺少必需外部条件时提出具体问题，继续其他独立工作。
- 不删除失败测试、缩减搜索范围、改变搜索语义、降低性能阈值、把缺表异常吞成空列表，或关闭能力后声称功能完成。
- 证据目录：`/Users/yang/Desktop/otto-new/docs/research/flea-market-evidence/`。新证据使用 `repair-pass-2-` 前缀，保留旧日志，不记录凭据、私信正文或私人照片。
- 结果分开写：内部代码/自动化是否完成、正式客户端是否验证、平台/外部上线条件是否满足。任何未验证项不能标通过。

## 3. Task 0：复现并重建问题清单

**文件：**更新缺陷台账和 execution-log，使用上述现有报告，不另建重复事实来源。

1. 记录当前 HEAD、分支、脏文件、开始时间和相关环境；确认其他开发者是否已经补了本文件所述问题。
2. 原样运行当前市场服务端专项，保留 2 项搜索失败或其实际最新结果。
3. 检查 `capacity.json` 和 `capacity-before-index.json` 的日期、数据规模及测量范围，不能混淆优化前后证据。
4. 建立编号：FMR-01 搜索索引/迁移，FMR-02 搜索性能及门禁，FMR-03 消息附件，FMR-04 多设备恢复/私聊复用，FMR-05 正式接入与可用性，FMR-06 生命周期/证据保留核验，FMR-07 报告一致性。对待验证项不能伪造“已复现 bug”。
5. 每条写复现命令、预期/实际、原因、修复位置、证据和状态。明确继承原有 FM 编号，不覆盖历史。

## 4. Task 1：完成隐私约束下的搜索索引和迁移

**文件：**

- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketSearchIndex.test.ts`
- 拟新增 `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketSearchIndex.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketSchema.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketSqliteRepository.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketPostgresRepository.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketService.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketDiscovery.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/postgresMigrations.ts`

先运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketSearchIndex.test.ts
```

基线：两个数据库均缺 `park_market_search_terms`。

按每个用例执行红→绿：

1. 先确定索引设计并更新技术决策：实现标题/描述的现有子串语义，不擅自改成只匹配整词或前缀。正常搜索、无结果、单字、emoji、大小写及普通 `%/_` 字符都需正确。
2. 索引表/文档版本/回填状态与查询一并实现。沿项目机制给 PostgreSQL 追加唯一迁移，给 SQLite 幂等升级；检查共享迁移编号，不能重写已经应用的迁移或创建空表仅让缺表错误消失。
3. 不能为性能把私密商品正文直接放入日志或未经讨论的明文索引。可研究园区范围的带密钥 n-gram 候选索引，再经授权解密精确核验；若采用，记录候选频率泄露、密钥来源/轮换、空间复杂度和低选择性查询成本。普通哈希可字典猜测，不等于加密。
4. 使用应用原有 key provider 派生受控索引键，不复用明文凭据、不写死密钥；园区/版本限定、删除和清理必须覆盖索引。避免生成全部子串造成 O(n²) 存储膨胀。
5. 发布、编辑及索引更新在同一事务，编辑后旧词不再命中；商品版本绑定索引版本。下架/移除/身份变化及时过滤，删除/正文清理移除无权残留信息。
6. 历史数据有持久、可续跑、可限批的回填；中断或部分回填不漏掉原本可见商品。允许正确的降级过程，但必须暴露维护状态及资源预算，不能让每次查询无界全扫描。
7. 双数据库验证首次迁移、重复迁移、旧数据升级、编辑回滚、服务/数据库重启、索引部分缺失回填及跨园区隔离。
8. 查询只对授权候选做有限解密，不逐商品反复查询同一卖家身份；在保持当前资格校验正确的前提下批量读取/请求内缓存，不能用过期跨请求缓存延迟撤权。
9. 搜索结果仍保持三种排序、每页 20 条、游标过滤指纹、无重复；不通过“只扫描前 N 件”掩盖慢查询。

完成标准：不仅两项红测通过，还需业务正确性、真实迁移/回填和 Task 2 性能证据。

## 5. Task 2：修复性能验收，并真正达到指标

**文件：**

- `/Users/yang/Desktop/otto-new/integration/park-market/capacity.test.ts`
- 上述 Discovery、Repository、SearchIndex。
- `/Users/yang/Desktop/otto-new/docs/research/flea-market-evidence/capacity.json`，保留原版本为基线，不直接覆盖优化前证据。

步骤：

1. 给容量脚本加显式输出路径，默认或本轮路径使用新前缀，不覆盖旧结果。保存指标后执行 P95 等指标断言，超标必须非零退出；测试只写 `passed:false` 不算门禁。
2. 数据规模保持 10 万历史、1 万活跃；数据应有不同标题、描述、卖家、类别、状态和冷热词。种子数据必须构建正确索引，不能直接 INSERT 业务表后宣称测试了完整索引路径；另测真实旧数据回填场景。
3. 维持 100 并发读场景，覆盖最新列表、无匹配搜索、少量命中、常见词、单字/emoji、价格/分类组合和后续分页。记录冷启动、首次回填后及稳定运行的差异。
4. 测量 SQLite/PostgreSQL 的 P50/P95/max、数据量、并发、硬件、耗时、索引体积/构建时间、解密数量和候选扫描数；用查询计划或 profile 定位瓶颈。别反复盲跑 100 个慢请求。
5. 普通查询服务端 P95 ≤ 1 秒。若达不到，继续优化、记录具体瓶颈；不得减少数据量/并发或改阈值让报表绿。
6. 服务层微基准不能替代 PRD 全部性能验收。再验证真实 HTTP/IPC 与页面首批可操作 P95 ≤ 3 秒，并记录 20 Mbps/100 ms RTT 条件；未做网络整形则明确测量条件不同。
7. 增加 100 并发活跃会话请求的代表性压力测试，以及写入/后台清理与读取同时进行时的影响。不能用 100 个列表查询代替“100 并发活跃会话”的全部要求。
8. 超时/取消要释放资源；全局写锁与清理全表扫描若造成阻塞，使用事务正确的分批、索引和任务租约改进，不能为并发撤掉额度/版本/授权原子性。

执行入口（先完成脚本的输出隔离和真实断言，再运行）：

```bash
OTTO_MARKET_CAPACITY=1 ./node_modules/.bin/vitest run --config packages/server/vitest.config.ts integration/park-market/capacity.test.ts
```

运行前只允许专用测试库；耗时测试有明确超时和进度，不影响生产。

## 6. Task 3：完成正常会话附件，保持首次请求限制

**文件：**

- `/Users/yang/Desktop/otto-new/packages/desktop/src/main/park-market-messaging.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/main/park-market-mls.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/MarketContactCenter.tsx`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketContacts.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/parkContactCiphertext.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/parkContactMls.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/data_platform/attachmentStorageService.ts`
- `/Users/yang/Desktop/otto-new/integration/park-market/encrypted-flow.test.ts`
- 拟新增 `/Users/yang/Desktop/otto-new/integration/park-market/attachments-flow.test.ts`。

1. 盘点已验收的普通私聊附件格式/数量/大小/加密/存储能力，市场只复用这些格式，不承诺任意附件。
2. 红测：首次消息请求不得带附件；接受后普通会话可以发送、读取、下载已支持附件，UI 有真实入口及进度/失败重试。
3. 沿现有安全模式完成附件加密和会话授权，不复用公开商品图片地址，不让服务器为了方便读取私聊明文。MLS 部署不能降级信封或明文绕过问题。
4. 消息提交/附件引用/额度形成可靠关联，丢响应重试不重复消息或重复计费，失败上传不留下永久孤儿。不要继续用 `attachments: []` 丢掉实际附件。
5. 验证双方可读、第三人/其他园区不可读；屏蔽、身份失效、设备撤销后的行为按原私聊与市场授权策略执行，商品删除不能误删双方仍获授权的独立聊天附件。
6. 实际 SQLite/PostgreSQL × 适用加密模式跑通附件往返及重启；加入真实 HTTP/对象存储授权测试。没有真实远端存储则记录未验证，不能拿本地对象替代其验收。
7. 关联商品卡、首问题、普通附件三个资源类型分开，不扩大举报者/管理员的读取范围。

## 7. Task 4：验证既有私聊复用与多设备恢复

**文件：**

- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketPrivateReuse.test.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/parkContactPrivateAuthority.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/main/park-market-mls.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/main/park-market-messaging.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/MarketContactCenter.tsx`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/InboxPage.tsx`

1. 当前私聊复用已有测试，不要照旧报告重建。验证真实既有企业会话进入商品咨询后不重复创建待处理请求/聊天，商品卡与问题落在正确位置。
2. 市场屏蔽只限制市场路径；独立私聊按原权限继续。不能删除原组织隔离、MLS或附件约束来让测试通过。
3. 测试原设备关闭重启、另一已批准设备、新设备未批准、设备撤销、丢失本地会话状态分别如何读历史/继续发消息。
4. 使用项目已有安全恢复机制提供可执行流程；没有恢复能力就明确引导并记录缺口，不能只显示“请恢复密钥”却没有对应入口。
5. 是否能读某段历史必须由现有消息安全/保留策略决定，不擅自给所有新设备发全部旧密钥，不把多设备同步简化成服务器存明文。存在 PRD 与既有安全策略冲突时写出具体选择及影响，不能暗中降级。
6. 重启重试、分页关联商品、已读同步、旧设备身份验证与历史附件读取同时验证，不能只断言数据库里有记录。

## 8. Task 5：把正式接入做完整，保留默认关闭和安全闸门

**文件：**

- `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/db.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/clusteredInfrastructure.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketSettings.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketApplication.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketSqliteRuntime.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketPostgresRuntime.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/moduleCatalog.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/state/useModuleWorkspaceCapabilities.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/App.tsx`

1. 查清正常装配为何硬编码 `ready: () => false`，区分依赖未实现与安全发布条件未满足。
2. 实现可诊断的 readiness，结合已确认的图片、数据库、消息、安全策略和任务依赖；保持生产默认关闭，不能仅通过一个 env=true 就绕过安全闸门。
3. 服务器协议支持、服务依赖就绪、园区运营启用分别表达；园区规则/处理责任人由授权角色配置，缺少必需条件拒绝启用并解释。
4. 提供隔离开发环境的显式启用方式，通过正常企业服务器和完整桌面 App 验证，不靠测试专用组件注入冒充正式接入。所有生产安全限制仍保留。
5. 模块目录中已经有市场条目，复核实际 capability 能否激活；市场暂停/移除模块/退出园区后个人中心本人记录继续可达，不能因 ready=false 阻断允许的历史管理。
6. 两种部署验证启动/停止worker、依赖故障、旧客户端能力不兼容、重复启动和重启恢复。只读接口不能暗中触发全量清理。

## 9. Task 6：完成真实桌面、图片与边界验收

**主要文件：**

- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/ParkMarketDialog.tsx`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/ParkMarketModel.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/MarketImageViewer.tsx`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/main/park-market.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/main/park-market-links.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketImageProcessing.ts`

按 PRD A01–A40 逐条核验，不只看组件是否渲染：

- 正常 App 登录两个同园区不同企业测试账号：真实图片发布→搜索→详情→咨询→回复→预留→修改交接时间→售出→原会话继续。
- 第三方、其他园区、普通企业管理员、停用账号验证访问隔离；通过直接 HTTP/图片地址访问同样不能绕过。
- 选择/拖拽/粘贴合计超过九图、混入坏图、改变封面、重试；真实 HEIC、旋转和 GPS 元信息清理；macOS/Windows 交付环境分别验证。
- 草稿最多 20 条、1 秒自动保存、马上关闭、保存失败、切账号、过期附件补选和重启；失败不清表单，不宣称未完成保存已经成功。
- 发布/咨询丢响应重试只产生一份事实；另设备修改导致冲突时保留输入；失效请求恢复商品后不复活。
- 内部分享运行中打开与系统协议冷启动、服务器/账号不匹配、无权限不泄露商品详情。
- 1024×768、125%/150%、键盘焦点、Esc、图片左右切换、缩放和排序替代操作。
- 通知服从偏好、未读持久化、跨设备已读、旧通知打开最新状态，不把收藏/浏览变成通知。

本地 fixture 和 JSDOM 保留用于快速回归，但报告必须与真实安装包证据分开。缺 Windows 环境时记录精确未验证项并准备可运行脚本，继续完成 macOS 和其他工作，不虚报双端通过。

## 10. Task 7：治理、保留、撤权与后台竞态补验

**文件：**

- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketJobs.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketAttachments.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketGovernance.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketModeration.ts`
- `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketMessageEvidence.ts`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/MarketReportForm.tsx`
- `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/MarketRoles.tsx`

1. 核对直接移除、处理中、结案、发布限制、恢复、申诉及后续新证据是否均有真实 API/UI，不照旧台账猜测缺口。普通企业管理员不可变成市场管理员。
2. 报告只附用户选择的消息/图片，不打开全部私聊。保留原密文及来源说明，举报者提供的明文不冒充服务器独立核实的原话。
3. 结案证据 180 天、连续结束商品 180 天、草稿租约30天+待清理7天和最小记录策略分别验证；已删除公开图不能从历史/草稿/共享对象地址绕回读取。
4. 依法或依项目强制策略的保全条件，接现有授权保留机制；没有已确认策略时明确列上线条件，不能自行声明永远保留或删除全部备份。
5. 续期与到期、发布绑定与清理、身份退出与咨询、删除与举报快照、双worker与失败重试分别以真实数据库并发屏障验证。
6. 保持原子额度、CAS及撤权，扫描优化不能让旧版本清理掉新绑定，也不能误删仍被治理/聊天独立引用的对象。

## 11. Task 8：重跑工程验证与实际影响回归

从 `/Users/yang/Desktop/otto-new` 分别运行并记录退出码：

```bash
npm run doctor
git diff --check
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market
./node_modules/.bin/vitest run --config packages/server/vitest.config.ts integration/park-market/encrypted-flow.test.ts
npm exec --workspace=packages/desktop -- vitest run src/renderer/components/ParkMarketDialog.test.tsx src/renderer/components/ParkMarketModel.test.ts src/renderer/components/MarketImageViewer.test.tsx src/main/park-market.test.ts src/main/park-market-links.test.ts
npm run typecheck --workspace=packages/server
npm run typecheck --workspace=packages/desktop
npm run build --workspace=packages/server
npm run build --workspace=packages/desktop
npm run code-map
npm run code-map:check
npm run validate:boundaries
```

- 新增附件、恢复、真实 UI 测试后把它们的精确命令纳入日志；真实 PostgreSQL 测试不能静默跳过。
- 对自己触及文件执行 ESLint。消息/安全/对象存储修改后运行原有 Inbox、企业私聊、MLS、附件、园区身份及受影响拼车回归，不只跑市场目录。
- 桌面 native prehook 是 TypeScript 构建，不等于 Rust 安全测试；改 Rust 后必须实际运行对应 Native 测试。
- doctor 已有源码超预算和其他共享工作区失败需记录归因；不删他人文件、不抬预算、不把所有失败都说成环境问题。
- 区分生产代码编译、真实数据库迁移、性能、双端验收，不能拿一种检查替代另一种。

## 12. Task 9：同步报告，最后自查后再判定交付

更新三份现有自查/bugs/execution-log及技术决策，过时版本保留为带时间的历史快照。新日志采用 repair-pass-2 前缀。

每行 F01–F07、A01–A40 必须包含：真实实现位置、测试文件/测试名/命令、证据链接、实际结果、剩余缺口及状态。复合项只要必要部分未过，不整行标通过。字段表及性能/隐私/双端要求也要验，不仅检查 A 编号齐全。

报告首部明确：

- 本轮修复了哪些可复现问题，新增或修复后实际测试数量。
- 搜索优化前后指标、测试条件、断言是否真正阻止不达标。
- 普通附件、设备恢复、正式App/协议分享、双平台分别验证到哪一步。
- 仍有多少内部缺陷、多少未验证项、哪些上线条件未满足。
- 服务能力为何关闭/何时可控启用，不能写已经部署。

提交最终回复前逐项自问：

1. 两个缺表红测是否真正由业务索引、迁移、回填解决，而不是空表或删断言？
2. 1 万活跃商品的无结果/低选择性搜索是否保持正确且达到目标？性能失败是否会让测试失败？
3. 两数据库迁移、旧数据回填、正文清理/索引撤权、版本冲突是否都有证据？
4. 正常会话附件与首次请求禁止附件是否两端都成立？原私聊安全模式是否保持？
5. 恢复密钥提示是否有真实可执行流程，未授权设备是否确实不可读？
6. 正常App与隔离测试、真实Windows与本机Node是否明确区分？
7. 现有私聊复用、模块入口等已实现项是否如实更新，旧台账是否不再误导？
8. 发现的内部缺陷是否已修复复测？未验证项有没有被错误标绿？
9. 是否保留其他开发者工作且未越权操作生产？

只有上述对应证据成立才能宣布相关部分完成。缺目标平台、运营策略、外部安全门禁等条件时，完成所有不依赖它的开发，清楚列出剩余验收和准备好的执行步骤。不得因为工期或上下文不足删减 PRD 并宣布全量完成。

**现在先读取文件并复现，从 Task 0 到 Task 9 执行修复。最终交付修复代码和验证报告，不要只再给用户一份计划。**
