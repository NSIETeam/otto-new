# Park Flea Market Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按 PRD v1.1 完整交付同园区个人闲置发布、发现、咨询、线下交接管理、消息和治理，并对 A01–A40 提供可复核证据。

**Architecture:** 沿用模块化单体：市场领域作为 park_services 子域，授权消息归 collaboration，附件底座归 data_platform。SQLite 和 PostgreSQL 共用领域服务、HTTP 契约与合同测试；桌面通过 main → IPC → preload → React 接入真实服务，“我的消息”和本人记录均有持久入口。

**Tech Stack:** TypeScript、Node.js（仓库要求 ≥22.16）、React 18、Electron、Vitest/Testing Library、SQLite/SQLCipher、PostgreSQL、现有加密对象存储；图片解码依赖须在执行前完成跨平台选型验证。

---

## 0. 状态、依据与执行边界

**本文件只是一份执行计划；当前未创建业务文件、迁移数据库、安装依赖、启动开发服务或执行下面的任务。** 计划使用 @superpowers:writing-plans 整理。执行阶段使用 @superpowers:executing-plans；实现业务规则时遵循仓库 TDD 要求，最终使用 @superpowers:verification-before-completion（可用时先读取相应 SKILL.md）。

- 仓库绝对路径：`/Users/yang/Desktop/otto-new`。
- 唯一产品基线：`/Users/yang/Desktop/otto-new/docs/plans/2026-09-08-park-flea-market-prd.md`，v1.1、F01–F07、A01–A40。计划不取代 PRD 的全部字段/时限/权限规则。
- 本计划：`/Users/yang/Desktop/otto-new/docs/plans/2026-09-08-park-flea-market-implementation-plan.md`。
- 交接提示词：`/Users/yang/Desktop/otto-new/docs/plans/2026-09-08-park-flea-market-ai-handoff-prompt.md`。
- 参考：`/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-customer-code-analysis.md`、`/Users/yang/Desktop/otto-new/docs/code-map.md`、`/Users/yang/Desktop/otto-new/docs/product-modules.md`、`/Users/yang/Desktop/otto-new/docs/runtime-kernel-boundary.md`。
- 计划核对的 HEAD：`93dcf8ea2dd0e9582589351a6e126ecd24b33b86`。工作区还有用户正在开发的拼车及其他未提交变更；HEAD 不代表当前全部代码，不能回退到该提交丢弃工作。
- 上轮 doctor 的源码体积超过 50 MB 预算（约 60.86 MB），这是已知基线问题；执行时重新检查、记录增量，不通过提高预算或删除别人的文件隐藏失败。
- writing-plans 建议专用 worktree。本轮仅在用户指定仓库写计划；执行者先确认正在使用的完整工作区基线，再准备专用工作区。只从 HEAD 创建 worktree 会漏掉用户正在做的拼车等更改，不得当作最新状态。不要自动 stash、reset、clean、pull 或搬动原目录；如隔离基线无法安全保留，继续在原目录精确限定文件改动并记录理由。
- 不执行线上部署、push、合并、生产数据库迁移或真实用户发信。测试账号/通知仅用于本地或专用测试环境。开发任务局部 commit 可在执行阶段完成，但只暂存本任务自己的变更；多人同时修改共享文件时不得把别人 hunk 一并提交，不用 `git add .`。
- 首发不做支付、订单、评价、库存、跨园区、求购、手机扫码或 AI 自动发布；“隐藏某卖家商品”留后续。不能因这些延期而遗漏首发中的 HEIC、功能状态、预留备注和关联商品列表。

## 1. 已核对的接入点与关键风险

| 已存在的绝对路径 | 用途及必须保留的约束 |
| --- | --- |
| `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/directMessageRepository.ts` | 当前路径有同企业 active 账号限制；不能直接删检查来支持市场跨企业。私信内容存在加密处理。 |
| `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/directMessageFacade.ts` | 复用门面和存储边界，不能假设它已经有陌生请求及市场授权。 |
| `/Users/yang/Desktop/otto-new/packages/server/src/modules/data_platform/attachmentStorageService.ts` | 已有附件元数据、加密模式、MLS 授权及存储生命周期；市场图片要独立资源授权。 |
| `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/parkMembershipRepository.ts` | 园区归属依赖企业成员关系；离职、转企及企业转园区均需核对。 |
| `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/enterpriseRouteDispatcher.ts` | 单机路由组合入口，现有 parkCarpoolRoutes 是薄适配参考。 |
| `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/clusteredBusinessRoutes.ts` | 集群接入点，与同事正在做的拼车共享，精确增加装配。 |
| `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/server.ts`、`/Users/yang/Desktop/otto-new/packages/server/src/enterprise/clusteredServer.ts` | 两种企业服务器能力公布与生命周期，不能只改一个。 |
| `/Users/yang/Desktop/otto-new/packages/desktop/src/main/enterprise-client.ts`、`/Users/yang/Desktop/otto-new/packages/desktop/src/preload/index.ts` | API/IPC 类型边界，避免在大文件不断堆业务。 |
| `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/InboxPage.tsx` | 已有统一消息聚合；市场必须真实接入，不用商品页面临时聊天代替。 |
| `/Users/yang/Desktop/otto-new/packages/desktop/src/main/enterprise-mls-private-messages.ts` | 当前安全私聊模式的客户端实现，执行前与实际服务器模式一起核对。 |
| `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/AccountManagementPage.tsx` | 本人历史后备入口候选，需复核其导航/权限后接入。 |

新增文件均为本计划的**拟创建路径**，不能在交付报告中写成已经存在。现有文件在执行时若重命名或有更合适分层，先更新本计划的路径映射及原因，再沿等价模块边界实现，不照抄过时行号。

## 2. Task 0：执行前基线与技术决策（当前不执行）

**Files:**
- Read: `/Users/yang/Desktop/otto-new/AGENTS.md` 及修改目录下的 AGENTS.md。
- Create: `/Users/yang/Desktop/otto-new/docs/plans/2026-09-08-park-flea-market-technical-decisions.md`。
- Create: `/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-flea-market-execution-log.md`。

**Step 1:** 读取完整 PRD、执行计划及模块边界；记录当前分支、HEAD、`git status --short`，对自己将触及的已有脏文件记录基线，绝不在日志写凭证。

**Step 2:** 用 `rg --files` 核对已有市场/消息/图片实现；先找可复用功能。查清 active 部署是传统私聊还是 MLS 路径、如何复用已有会话、未读及图片适配器，记录实际函数/文件名。

**Step 3:** 运行 `npm run doctor`、`git diff --check`，记录原有失败。核实 Node、native binding、真实 PostgreSQL、图片解码器、双端测试环境，区分可继续开发与阻塞验证的条件。

**Step 4:** 写一页技术决策：①跨企业会话如何保持原加密模式和授权来源，②首问题与请求的可靠提交边界，③即时撤权图片网关/缓存，④真实 HEIC 解码与打包方式，⑤SQLite/PostgreSQL迁移与worker生命周期，⑥本人入口和最小记录保留策略。给出选择和依据，不能只列候选让后续任务无限等待。仅遇 PRD 与既有安全/数据策略无法同时满足时提出具体冲突并继续独立工作。

**Step 5:** 创建独立测试账号和数据库命名计划；必要连接配置由执行环境提供，报告只写变量名/启动方式，不写值。技术未知不等于允许硬编码假数据或关闭鉴权。

**Step 6:** 将 F01–F07 与 A01–A40 复制成待验收清单。阶段内每一条测试先失败，再最小实现，再跑绿；没有权限/环境证据的状态维持未验证。

## 3. 接口与数据合同（拟定实现约束）

路由前缀 `/enterprise/park-flea-market`，写操作携带 `requestId` 和适用的 `expectedVersion`，身份来自认证上下文。每个真实动作都通过服务端授权；历史管理路由与公开路由分开。HTTP 错误建议 401/403/404/409/422/429/503，成功返回对象 ID、版本、当前状态及允许动作；跨园区详情按一致不可用行为隐藏存在性。

| 接口组 | 拟定操作 |
| --- | --- |
| 状态/发现 | `GET /state`、`GET /listings`、`GET /listings/:id` |
| 本人记录 | `GET /mine`、`GET /mine/:id`（原园区本人记录管理，非公开详情后门） |
| 发布/编辑 | `POST /listings`、`PATCH /listings/:id`、`GET /operations/:requestId` |
| 状态 | `POST /listings/:id/reserve`、`PATCH /listings/:id/reservation`、`POST /listings/:id/cancel-reservation`、`POST /listings/:id/offline`、`POST /listings/:id/sold`、`POST /listings/:id/undo-sold`、`POST /listings/:id/restore-offline`、`POST /listings/:id/relist`、`POST /listings/:id/confirm-active`、`DELETE /listings/:id` |
| 图片/草稿 | `POST /images`、`GET /images/:id/status`、`GET /images/:id/content`、`PUT /drafts/:id/lease`、`DELETE /drafts/:id/lease`；上传协议沿附件底座，可补 multipart 子接口 |
| 收藏 | `GET /favorites`、`PUT /favorites/:listingId`、`DELETE /favorites/:listingId` |
| 咨询 | `POST /listings/:id/questions`、`GET /requests`、`POST /requests/:id/accept`、`POST /requests/:id/reply`、`POST /requests/:id/ignore`、`POST /requests/:id/withdraw` |
| 会话 | `GET /conversations`、`GET /conversations/:id/messages`、`POST /conversations/:id/messages`、`POST /conversations/:id/read`、`GET /conversations/:id/listings`；统一会话底座承载，不复制两套已读/消息 |
| 屏蔽/通知 | `PUT/DELETE /blocks/:peerAccountId`、`GET /blocks`（本人可管理）、`GET /notifications`、`POST /notifications/:id/read` |
| 治理 | `POST /reports`、`GET /my-reports`、`GET /admin/reports`、`GET /admin/reports/:id`、`POST /admin/reports/:id/actions`、`POST /listings/:id/appeals`、`GET /my-appeals`、`GET /admin/appeals`、`POST /admin/appeals/:id/actions` |
| 配置/限制 | `GET /rules`、`GET/PATCH /admin/config`、`GET/POST /admin/restrictions`、`DELETE /admin/restrictions/:id`；操作理由与审计必需 |

原消息 API 可通过适配复用，最终 URL 可遵项目一致性调整，但要更新此表、客户端和合同测试。任何未支持路径都不能返回 `{success:true}` 占位。

核心写入顺序：认证主体 → 幂等结果检查 → 锁定/校验当前授权与对象版本 → 校验字段/附件/额度/状态 → 原子写业务及历史/授权/额度/可靠事件 → 提交 → 异步投递。首次问题若是密文，数据库事务包含密文与商品快照元数据，不在日志或管理端解密。事务失败不产生半条请求、孤立会话或已扣额度。

## 4. 可直接采用的首轮红绿测试样例

这些是**拟新增纯函数的完整示例**，不是已运行的代码；后续服务应调用它们，不在各层复制规则。

文件：`/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketValidation.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { parseSalePriceCents } from './fleaMarketValidation.js';

describe('parseSalePriceCents', () => {
  it.each([['0.01', 1], ['12.3', 1230], ['999999.99', 99999999]])(
    '%s converts without floating point rounding', (text, cents) => {
      expect(parseSalePriceCents(text)).toBe(cents);
    },
  );
  it.each(['0', '-1', '1e3', '1.001', '1000000', '面议'])('rejects %s', text => {
    expect(() => parseSalePriceCents(text)).toThrow('INVALID_PRICE');
  });
});
```

文件：`/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketValidation.ts` 中对应最小实现（先跑上面红测，再写）：

```ts
export function parseSalePriceCents(input: string): number {
  const match = /^(0|[1-9]\d{0,5})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) throw new Error('INVALID_PRICE');
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 99999999) {
    throw new Error('INVALID_PRICE');
  }
  return cents;
}
```

文件：`/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketRequestLifecycle.test.ts`

```ts
import { expect, it } from 'vitest';
import { pendingRequestDisposition } from './fleaMarketRequestLifecycle.js';

it('does not extend request expiry during a market pause', () => {
  const request = { expiresAtMs: 2000, nowMs: 2000, marketEnabled: false,
    participantsAllowed: true, listingState: 'active' as const };
  expect(pendingRequestDisposition(request)).toBe('expired');
});
it('keeps a reserved listing request actionable', () => {
  expect(pendingRequestDisposition({ expiresAtMs: 2000, nowMs: 1000,
    marketEnabled: true, participantsAllowed: true,
    listingState: 'reserved' })).toBe('actionable');
});
it('ends an offline listing request even while the market is paused', () => {
  expect(pendingRequestDisposition({ expiresAtMs: 2000, nowMs: 1000,
    marketEnabled: false, participantsAllowed: true,
    listingState: 'offline' })).toBe('ended');
});
```

对应最小实现（已有终态请求不得再次调用它来复活；reason 在上层按受限投影展示）：

```ts
export function pendingRequestDisposition(input: {
  expiresAtMs: number;
  nowMs: number;
  marketEnabled: boolean;
  participantsAllowed: boolean;
  listingState: 'active' | 'reserved' | 'offline' | 'sold' | 'removed' | 'deleted';
}): 'ended' | 'expired' | 'paused' | 'actionable' {
  if (!input.participantsAllowed) return 'ended';
  if (input.nowMs >= input.expiresAtMs) return 'expired';
  if (input.listingState !== 'active' && input.listingState !== 'reserved') return 'ended';
  return input.marketEnabled ? 'actionable' : 'paused';
}
```

这两个样例仅覆盖两个纯规则，不替代数据库/权限/消息/图片端到端测试。其余任务的每条 Given/When/Then 用例都应单独写成真实可运行测试；完成一个用例的红→绿→重构，再做下一条。每个 Step 是一次操作，约 2–5 分钟；一个 Task 包含多个这样的循环，不要求把整个领域模块压成一次大修改。

## 5. 分任务执行顺序

依赖：Task 0 → 1–4 → 5–10；11 依赖 2–4 和 Task 0 会话决策；12–16 依赖相关存储与授权；17 统一装配；18–23 接客户端；24 完整验收。编号以下文为准，不跳过依赖进行生产接入。

### Task 1: 字段契约、错误类型和纯校验

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketTypes.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketValidation.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/index.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketValidation.test.ts`

**PRD 验收对应：** A03,A14,A24,A39。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 0 元出售被拒绝，免费送持久化为 0 分；0.01 与 999999.99 边界有效，科学计数法、超两位小数被拒绝。
- 标题按可见字符计算，emoji 不被拆开；分类、成色、功能状态均不得静默默认。
- 故障状态缺少 2–500 字故障说明被拒绝；图片必须 1–9 张且全部可用。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketValidation.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 定义商品、请求、预留、授权、通知、分页及错误 DTO；价格输入以十进制字符串转换成整数分，禁止浮点乘 100 后取整掩盖非法输入。
- 用 Intl.Segmenter 统一可见字符规则；公共详情 DTO 与本人详情/治理证据 DTO 分开，私有备注不靠客户端隐藏。
- 统一错误码 INVALID_INPUT、UNAUTHENTICATED、FORBIDDEN、NOT_FOUND、CONFLICT、LIMIT_REACHED、DEPENDENCY_UNAVAILABLE，携带可公开的字段错误/重试时间，不以中文正则分类错误。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: define flea market contracts`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 2: 真实测试夹具与 SQLite 数据迁移

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketSchema.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketRepository.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketSqliteRepository.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketTestSupport.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/db.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketSqliteRepository.test.ts`

**PRD 验收对应：** A07,A16,A26,A38。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 首次迁移和重复迁移均成功，旧账号/私信/园区数据保持不变。
- 两个同版本写入只有一个成功；失败事务不留下事件、额度或附件绑定。
- 同一操作标识只生成一条成功结果，同标识不同摘要被拒绝。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketSqliteRepository.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 先参照现有 schema contributor 接入方式建立真实临时 SQLite/SQLCipher 数据库；夹具包含园区 P/Q、P 内企业 E1/E2、买卖双方/陌生人/园区市场管理员/普通企业管理员及停用账号。
- 建立商品/图片引用/草稿租约/收藏/请求/逐商品历史授权/屏蔽/状态历史/治理/额度/幂等/outbox/任务租约表；请求会话的存储归 collaboration，避免同一事实存两套。
- Repository 暴露事务单元，以 actor、version、idempotencyKey、requestHash 作为写入契约；JSON 可存扩展字段，但过滤、排序、权限及任务索引字段须可查询；添加必要唯一约束和复合索引。
- fleaMarketTestSupport 只负责夹具和调用真实服务，不能返回预设成功结果；显式控制时钟、事务屏障、故障注入及关闭资源。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: persist flea market state`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 3: PostgreSQL 迁移及同契约存储

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketPostgresRepository.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/modules/data_platform/enterprisePostgresMigrations.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/postgresBusinessRepository.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketRepositoryContract.test.ts`

**PRD 验收对应：** A16,A26,A30,A36,A38。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 同一 CRUD/版本冲突/幂等用例在 SQLite 与真实 PostgreSQL 上返回相同业务结果。
- 双连接抢最后一个发布额度只有一方成功；日期边界结果一致。
- 迁移可重复启动，原企业数据不变，数据库重启后状态可读。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketRepositoryContract.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 沿现有迁移机制追加版本，不改已部署迁移编号；迁移前记录数据库版本，说明升级与回退兼容范围。
- 实现与 SQLite 相同 Repository 契约，事务内锁定额度和状态、唯一约束兜底；不以进程内 Map 或只供测试的假 PostgreSQL 替代。
- 建立 test.each 后端合同测试；真实 PostgreSQL 连接缺失时明确列为未验证，不把自动 skip 算通过；仅使用专用测试数据库/schema。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: add postgres flea market repository`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 4: 身份解析、市场开关和本人历史访问

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketAccess.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/parkMembershipFacade.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/parkMembershipRepository.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketAccess.test.ts`

**PRD 验收对应：** A01,A02,A18,A19,A20,A21,A32,A37。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 同园区跨企业可浏览，跨园区账号即使伪造 parkId 也不可见。
- 退出园区/市场暂停仍能读本人允许保留的历史文本，但不能发售或读原园区图片。
- 企业管理员不能治理员工商品；市场管理员只能治理授权园区；停用账号任何入口均拒绝。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketAccess.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 从认证账号、当前企业归属及园区状态推导主体，组织成员关系变化也必须实时反映；区分 discover/publish/contact/manageOwn/history/moderate 权限。
- 公共 DTO 白名单序列化，不返回公司/职位/电话/精确门牌/私有预留备注；管理入口权限不依赖市场发现开关。
- 园区市场权限采用显式授权，默认只给经配置的市场处理角色；普通企业 isAdmin 不能自动获得治理权；无权读取返回一致不可用结果。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: enforce flea market access policies`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 5: 图片解码与双端格式能力

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketImageProcessing.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketImageService.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/package.json`
- Modify: `/Users/yang/Desktop/otto-new/package-lock.json`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketImageProcessing.test.ts`

**PRD 验收对应：** A04,A05,A25。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 真实带方向与 EXIF 定位的样本转码后方向正确、定位元信息不存在。
- 真实 HEIC/HEIF 可生成缩略图和详情图；后缀伪装、损坏文件、超 20 MB、超解码像素预算被拒绝。
- 单文件失败不污染其他成功附件，处理超时可明确恢复。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketImageProcessing.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- Task 0 的技术决策选择能在交付 macOS/Windows/企业服务器环境实际运行的解码器，锁定版本并保留安装与运行说明；不假定文件选择器接受即支持。
- 分离上传、解码检查、转码、可用状态；校验真实文件类型、尺寸/像素/内存/时间预算，详情分辨率要能看清瑕疵。
- 用自有或明确可使用的非个人测试样本；如果无需新增依赖就不改 manifest/lock；新增原生依赖必须覆盖交付环境并验证失败提示。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: process flea market images`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 6: 附件存储、访问撤销与草稿租约

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketAttachments.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketDraftLease.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/modules/data_platform/attachmentStorageService.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/modules/data_platform/attachmentObjectStoreRuntime.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketAttachments.test.ts`

**PRD 验收对应：** A02,A06,A19,A22,A35,A36。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 跨园区或换账号重放附件 ID/地址被拒绝，删除后原地址新的读取立即失败。
- 草稿续租 30 天；租约失效后 7 天待清理；其他账号无法续租或抢绑定。
- 删除编辑草稿中的图片不会删掉当前公开版本；清理与发布绑定并发不误删。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketAttachments.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 复用数据平台加密对象存储与配额，不把商品图片假装成企业私信附件；资源范围区分园区商品、本人草稿、选定治理证据。
- 鉴权网关每次读取重新检查主体和对象状态；不把仍可访问 10 分钟的裸 S3 预签名链接当作即时撤权，缓存策略也不能绕过鉴权。
- 将对象写入与元数据可靠关联；失败可补偿并留待孤儿清理，任何活跃引用/治理独立证据不得误删；租约时间由服务端生成。
- 草稿附件登记仅含账号、草稿 ID、附件引用及续租时间；不把正文上传同步冒充本机草稿需求。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: secure flea market attachments`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 7: 发布、发现与稳定分页

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketService.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketDiscovery.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketPublication.test.ts`

**PRD 验收对应：** A01,A02,A03,A07,A24。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 两个重试只创建一件商品，图片绑定、版本、状态与额度同事务。
- 市场默认含在售/预留；免费筛选及价格排序正确，文字更新/确认在售不刷排名。
- 20 条活跃及自然日 10 次发布额度并发不能突破；加载更多并发改价不重复展示 ID。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketPublication.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 公开前重读身份/配置/图片状态；成功前不丢草稿；同标识不同内容报冲突，查询未知结果需要归属校验。
- 搜索标题描述的普通文本，转义 SQL LIKE 通配符；三种排序按价格/上架时间/ID 形成稳定顺序；游标校验过滤条件并防跨园区使用。
- 服务端按园区时区计算自然日额度；正式重新上架也计入每日发布次数；客户端按 ID 合并分页并避免旧筛选响应污染新列表。
- 明确市场空、无搜索结果、无权限、依赖不可用四种不同响应。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: publish and discover flea market listings`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 8: 编辑、收藏和内部分享权限

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketEditing.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketFavorites.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketEditing.test.ts`

**PRD 验收对应：** A11,A14,A16,A22,A34。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 编辑与售出并发不会复活商品，原公开版本在提交成功前不变。
- 改价后旧咨询快照不变；换分类或替换全部图片需确认同物，更换物品产生新草稿。
- 收藏幂等且不通知，终态/删除/无权限占位不同；内部分享不能泄露跨园区数据。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketEditing.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 保存整份新版本及引用差异，失败保持旧版本；同物确认令牌/确认字段绑定所编辑版本，不能忽略换物规则。
- 收藏不授予历史详情权；分享只生成可由应用现有 deep-link 路由解析的内部链接，不自动向外发消息。
- 删除、移除及内容清理后的详情按权限返回占位，服务器不把整条数据库记录直接回传。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: edit and save flea market listings`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 9: 预留、时间修改和私有备注

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketReservation.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketReservation.test.ts`

**PRD 验收对应：** A12,A27,A39。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 交接时间越过有效期时普通预留失败；显式续期与预留一次成功，排名不变。
- 时间修改仅更新提醒版本，旧提醒不会发；备注变更不重置提醒。
- 到期后取消预留不恢复在售；清除时间重新起算 3 天；结束预留清空私有备注。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketReservation.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 实现 PRD 9.3 全部检查，包括未来 30 天内且严格早于到期、市场启用/资格/版本、200 字本人备注。
- 把开始/修改/清除时间作为不同命令，时间修改不短暂发布、不重开新咨询；结束预留撤销任务/清空备注。
- 普通操作 DTO、商品快照、日志、通知、举报默认上下文不包含备注。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: manage flea market reservations`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 10: 下架、售出、撤销与正式重新上架

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketLifecycle.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketLifecycle.test.ts`

**PRD 验收对应：** A13,A15,A16,A21,A28,A29,A30。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 主动下架不足 24 小时且无后续变更可恢复原排名/原有效期；到期/身份/治理下架不能走误恢复。
- 撤销售出已过原有效期只恢复下架，原预留不恢复；超过撤销窗口仅创建新草稿。
- 23:59 正式重新上架后次日 00:01 被滚动 24 小时限制；下架可直接标记售出。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketLifecycle.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 状态机统一校验主体、版本、原因、原状态/原有效期；所有副作用写入同一事务；状态指令不可直接设置任意目标状态。
- 正式上架校验字段、图片、身份、开关、治理、活跃额度/自然日次数和滚动冷却；误恢复不计发布额度，但仍校验活跃额度。
- 删除不可恢复；已售出复制不继承收藏/咨询/备注；管理员移除不能由本人通过编辑、撤销或复制绕过。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: complete flea market listing lifecycle`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 11: 跨企业会话授权与存储桥接

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/parkMarketConversation.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/parkMarketConversationRepository.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/directMessageFacade.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/directMessageRepository.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/collaboration/parkMarketConversation.test.ts`

**PRD 验收对应：** A01,A09,A10,A19,A33。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 同园区跨企业双方接受请求后可聊，但不能枚举对方企业目录/其他私信。
- 双方反向同时发起最终只有一个园区账号对请求/会话，复用已有获授权私聊不生成双会话。
- 只移除市场授权时独立企业私聊按原规则可用，未经授权者仍不能读历史或附件。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/collaboration/parkMarketConversation.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 先落实 Task 0 的会话适配决策：以 canonical unordered pair＋park 作为市场会话关联唯一键，将授权来源和逐商品关联显式建模。
- 保留现有同企业私聊接口默认限制；增加显式 market grant 的受控入口，不删除 organization 校验或允许任意 peerAccountId。
- 会话逻辑归 collaboration，市场服务通过同事务接口组合；统一消息页可以聚合不同存储，但不能出现未联入统一消息的孤立聊天室。
- 遵守现有企业私聊/MLS/E2EE模式；不能为了服务端读首条问题而把受保护会话降级明文。客户端准备受保护消息载荷，服务端原子落载荷、请求和商品元数据；若底层跨系统，需持久 prepare/commit 及用户可查的提交状态，不能先展示成功再异步丢消息。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: authorize park market conversations`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 12: 首条问题、请求状态机及发送幂等

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketContact.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketRequestLifecycle.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketContact.test.ts`

**PRD 验收对应：** A08,A09,A10,A16,A23,A31,A38。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 只点联系不创建请求；首条问题与快照一起到达，接受/首次回复后正常聊天。
- 请求待处理不可追加；7 天到期；撤回/忽略/反向接受/换商品遵守规则及限额。
- 下架与首次发送、接受与终止并发符合提交顺序；超时重试只记一次额度/问题/通知。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketContact.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 按 PRD 8.3 的每一行做 table-driven 测试，暂停市场只暂停接受且 7 天继续计时；终止记录保留且不复活。
- 用本次商品版本与最新权限验证；一次提交包含请求/卡/消息/历史关联/额度/outbox；只在成功时记额度。
- 同一标识不同 payload 拒绝；已完成操作重试返回原结果，但先验证仍是原调用主体，账号停用不泄露结果；未成功重试按最新商品状态。
- 已有会话的新商品问题同样走此路径；同商品请求 24 小时冷却、园区自然日单卖家 1 次/最多 10 位卖家，既有会话普通消息沿用基础频控。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: persist flea market contact requests`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 13: 历史授权、商品上下文和屏蔽

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketHistory.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketBlock.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketHistory.test.ts`

**PRD 验收对应：** A14,A19,A20,A22,A32,A33,A40。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 咨询 A 不可读取同卖家已下架 B；失败咨询/收藏不产生商品授权。
- 已送达但撤回/到期请求保留允许的历史；删除/移除/资格失效撤销图片及详情。
- 换商品不能绕过屏蔽；关联商品按会话真实咨询去重，失效对象只有允许的占位。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketHistory.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 按 PRD 8.4 构造访问投影，授权键包含园区/商品/账号/成功咨询依据，不以双方会话存在代替。
- 快照文字与当前状态分开；关联商品只返回实际涉及列表，可定位首次/最近咨询消息，不列卖家所有商品。
- 屏蔽是账号对双向市场联系限制，解除不补发；同企业独立私聊沿原规则；服务端和客户端文案保持同一范围。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: scope market history and blocking`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 14: 可靠事件、未读和后台任务

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketOutbox.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketJobs.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketNotifications.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketJobs.test.ts`

**PRD 验收对应：** A12,A17,A23,A26,A27。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 卖家离线时咨询/通知持久化，重启后仍在，未读查询不意外标记已读。
- 续期与到期任务并发不被旧任务下架；两个 worker 抢同任务不重复逻辑通知。
- 预留修改时间/结束后旧提醒失效；清理前通知/治理通知去重并打开最新状态。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketJobs.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 定时任务在服务端运行，时间来自可注入 clock；持久任务游标或扫描索引、lease、重试退避、失败可观察，生命周期随服务器启动/停止管理。
- 事务 outbox 与商品写入共提交，投递失败不回滚成功操作；通知消费者按事件/收件人唯一键保证一次可见，不声称网络 exactly-once。
- 已读状态服务器持久化、跨设备同步；消息入口未读查询只读；系统弹窗用泛化摘要且服从偏好。
- 不要用轮询客户端打开窗口触发业务到期；完成幂等过期修正与周期提醒、通知重启恢复测试。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: deliver durable flea market notifications`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 15: 内容保留、草稿清理和身份联动

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketRetention.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketIdentityReconciliation.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketRetention.test.ts`

**PRD 验收对应：** A19,A22,A26,A35,A36。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 连续结束 180 天才清理，结束态互转不重置；恢复在售终止本轮清理。
- 商品清理不删独立治理证据，最小记录/快照文本按各自策略保留。
- 组织转园区/账号停用立即拒绝公开读取和新联系；后台对账最终落下架且不会自动跨园区搬迁。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketRetention.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 读写权限即时检查为撤权底线；身份事件可靠触发下架及请求终止，服务端对账任务补偿漏事件，不在对账前暴露旧数据。
- 清理时 version＋state＋retentionDeadline CAS，活跃引用及治理保全检查；清理后只能补齐字段和新图新建 ID，禁一键恢复。
- 本机草稿可恢复文字而图片租约可能失效；释放引用有待清理窗口，通知提前 7 天；记录实际清理范围和失败原因，脱敏审计。
- 没有已确认的最小记录/备份保留策略时写入上线阻塞项，不自定永久保留或清空所有人的聊天。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: retain and reconcile market records`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 16: 举报、处理、发布限制与申诉

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketModeration.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketModeration.test.ts`

**PRD 验收对应：** A20,A21,A31,A34。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 同人同对象未结举报唯一，管理员只见授权园区和用户选定证据。
- 举报快照不随商品编辑改变；移除后本人不能上架，恢复后只到下架。
- 限制发布有原因及期限，已有在售/预留下架；申诉仅一条待处理，解除不复活请求。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketModeration.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 商品/消息举报独立证据授权，附最多 3 图，消息只含用户选定内容；保护现有加密消息，由用户端明确选择后提交解密的证据副本，不给管理员万能读私聊权限。
- 治理动作和审计/通知原子写入；管理员不得修改卖家价格或冒充售出；检查当前市场角色不是客户端自报。
- 实现待处理/处理中/已处理、无违规/移除/发布限制/恢复及申诉，新证据后续再申诉；限制发布不静默限制所有聊天。
- 保存运营配置：允许/禁止物品说明、联系人/责任人；公开可见；先提供关闭状态配置流程，没有责任人/规则不开放试点。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: moderate flea market content`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 17: 统一 HTTP 路由、组合根与能力开关

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketHttp.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/parkFleaMarketRoutes.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/enterpriseRouteDispatcher.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/clusteredBusinessRoutes.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/db.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/server.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/enterprise/clusteredServer.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/server/src/index.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketHttp.integration.test.ts`

**PRD 验收对应：** A01,A02,A18,A26,A37,A38。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 真实 HTTP 走认证→路由→服务→数据库，跨园区、状态冲突、未知幂等结果查询均按约定响应。
- SQLite/集群使用同一处理器与 DTO，未就绪依赖返回明确不可用且不宣告完整能力。
- 本人记录 GET 在市场关闭后可达，但不能用管理路径发布/查看他人。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketHttp.integration.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 路由前缀 /enterprise/park-flea-market；按计划的 API 表接入，未知路径/方法正确 404/405；body 大小、参数、文件请求全部限制。
- 单机薄适配注入 SQLite，集群注入 Postgres，同一 service/HTTP 处理器，避免两份业务逻辑。
- 在两种服务器启动/停止钩子注册任务 worker；模块归 park_services，不另造稳定产品模块 ID。
- 能力标识 park_flea_market_v1 与园区启用开关分开；依赖就绪才宣告，生产园区默认关闭；历史管理能力在市场暂停后仍可服务。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: expose flea market service endpoints`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 18: 桌面主进程、IPC、preload 与预览契约

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/main/park-flea-market-client.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/main/enterprise-client.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/main/index.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/preload/index.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/browserPreviewBridge.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/desktop/src/main/park-flea-market-client.test.ts`

**PRD 验收对应：** A04,A05,A07,A26,A38。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 带认证调用真实路由 DTO，不允许 renderer 自报 accountId 绕过主体。
- 服务能力缺失/超时/字段错误通过 typed result 传到 UI，状态版本和幂等键不丢。
- 预览适配与 preload 方法齐全，文件取消与读取失败不伪装成功。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/desktop -- vitest run src/main/park-flea-market-client.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 新增狭窄 market client/IPC 注册函数，主文件只装配，不再塞巨大业务实现；类型通过 type-only 导入共享契约。
- 完成上传/租约/列表/详情/收藏/状态/请求/消息/治理/通知/本人历史全方法，含未知结果查询和文件字节校验。
- 预览桥可接真实开发服务器；仅视觉 fixture 明确标记演示，不能作为端到端交付；上传 IPC 限大小/文件类型，不暴露任意文件读取。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: bridge flea market desktop APIs`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 19: 市场导航、管理后备入口与列表详情

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketPage.tsx`
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketDetail.tsx`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/App.tsx`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/ParkServicesPlugin.tsx`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/AccountManagementPage.tsx`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/moduleCatalog.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/state/useModuleWorkspaceCapabilities.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketPage.test.tsx`

**PRD 验收对应：** A01,A02,A11,A18,A25,A37。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 市场/收藏/本人发布可切换，详情返回保留搜索过滤与滚动；自己的商品没有联系自己。
- 免费筛选清空价格区间；清除搜索保留筛选；加载错误不清空旧结果。
- 移除模块/市场暂停/退出园区后从个人中心本人记录仍可达；无权限不显示图片。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/desktop -- vitest run src/renderer/components/flea-market/FleaMarketPage.test.tsx
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 复用现有组件和样式，不重做整个首页；数据 hook 分离，异步请求带取消/版本标识防旧响应回填。
- 列表 20 条加载更多、分类与价格三排序、预留开关、图片占位；详情显示功能/故障及可见状态操作。
- 内部分享 deep link 在冷启动和运行中均可路由；无权只显示不可用；个人中心记录与市场管理复用相同组件，区分可用动作。
- 用 capability 控制发现入口，用本人记录权限控制管理入口；不要因隐藏模块删除任何发布。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: build flea market discovery UI`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 20: 发布编辑表单、图片和本机草稿

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketEditor.tsx`
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketImagePicker.tsx`
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/fleaMarketDraftStore.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketEditor.test.tsx`

**PRD 验收对应：** A03,A04,A05,A06,A07,A25,A34,A35,A39。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 拖拽/选择/粘贴合计限 9 张，单图失败可删/重试，成功图不重传；封面可键盘调整。
- 输入 1 秒保存，切账号隔离、重启恢复；草稿超 20 条不删最旧，保存失败不显示已保存。
- 发布超时保留同一标识查询，不丢表单；编辑冲突保留输入；故障说明缺失定位首错。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/desktop -- vitest run src/renderer/components/flea-market/FleaMarketEditor.test.tsx
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 图片状态按单文件处理，服务端完成检查前不允许正式发布；HEIC 真文件测试属于双端交付任务，不由 jsdom 冒充。
- 本机持久草稿按账号及草稿 ID 隔离，安全沿用现有存储策略；上传引用登记/租约失败明确标识；取消上传和退出先保留可恢复输入。
- 退出三个动作必须真实可行；等待保存失败仍保持编辑页；免费切换恢复本次价格且用户确认；同物检查提示创建新草稿。
- 2–40 标题/5–2000 描述/正常或故障状态/交接信息严格同步共享校验；大件提示不新增多余必填。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: build flea market editor and drafts`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 21: 本人发布、预留与结束状态 UI

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketMyListings.tsx`
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketReservationDialog.tsx`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketMyListings.test.tsx`

**PRD 验收对应：** A12,A13,A15,A18,A21,A22,A27,A28,A29,A37。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 预留显示有效期，跨期必须显式续期；直接改时间、私有备注与取消预留正确。
- 下架前展示待处理请求数量提示，结束请求只读；误恢复不承诺恢复咨询/预留。
- 售出需确认，删除不可恢复需确认；清理后只能补齐信息另发，管理员移除仅申诉/隐藏。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/desktop -- vitest run src/renderer/components/flea-market/FleaMarketMyListings.test.tsx
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 按在售/预留/下架/售出/草稿/移除分类与计数，操作失败不提前移动卡片，冲突提供最新状态。
- 所有按钮由服务端 action availability 与当前状态共同决定，不能用按钮 disabled 替代接口校验。
- 保留已结束记录的清理时间说明；本人记录在市场关闭/身份变化后显示权限限制与可执行动作，不出现不可达死页。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: build flea market listing management`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 22: 统一消息中的请求、聊天、关联商品与通知

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketConversation.tsx`
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketRequestCard.tsx`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/InboxPage.tsx`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/enterpriseUnreadNotifications.ts`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/main/notification-service.ts`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketConversation.test.tsx`

**PRD 验收对应：** A08,A09,A10,A14,A19,A20,A23,A31,A32,A33,A38,A40。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 点联系关闭不发消息；输入首问题显式发送，卖家回复同时接受；失败保留输入。
- 市场会话出现在我的消息，消息请求/普通消息/系统通知分类型，重启后未读仍在。
- 改价旧快照不变，关联商品可定位原消息；被屏蔽/暂停/到期正确只读；两设备已读同步。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/desktop -- vitest run src/renderer/components/flea-market/FleaMarketConversation.test.tsx
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 复用统一会话目录与现有消息安全传输链路，不另做仅页面内可用的临时聊天；初次请求禁止附件，正常会话只开放现有已验证附件。
- 实现接受后稍后回复、忽略、撤回、屏蔽/举报；首次/已有会话商品发送使用统一幂等流程。
- 通知按泛化摘要显示，点击旧通知打开最新状态；不使用管理员全量私信接口展示举报选择。
- 焦点/键盘/输入内容留存、失败重试、过期按钮撤销覆盖到实际组件。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: integrate market conversations into inbox`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 23: 举报申诉与园区治理 UI

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketReportDialog.tsx`
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketAdminPanel.tsx`
- Modify: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/EnterpriseAdministrationPanel.tsx`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/components/flea-market/FleaMarketAdminPanel.test.tsx`

**PRD 验收对应：** A20,A21,A31,A34。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- 提交举报前列明所选消息/图片证据，不擅自附全部聊天；其他原因必填。
- 普通企业管理员无市场治理入口；授权市场管理员能处理且显示原因/执行人/时间。
- 移除/限制/恢复与申诉结果真实落库，重复举报/申诉显示已有记录，解除后不自动上架。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/desktop -- vitest run src/renderer/components/flea-market/FleaMarketAdminPanel.test.tsx
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 工作台按待处理/处理中/已处理展示可访问证据，操作版本冲突时刷新不覆盖他人处理。
- 商品举报/消息举报入口、本人申诉入口、隐藏移除记录、限制结束时间/永久选择、规则及责任人配置全部闭合。
- 故障反馈可恢复，敏感证据不进入公共图片接口；界面上的功能开关不能越过服务器授权。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`feat: build flea market moderation UI`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

### Task 24: 真实双账号联调、双部署和交付检查

**Files:**
- Create: `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketEndToEnd.integration.test.ts`
- Create: `/Users/yang/Desktop/otto-new/packages/desktop/src/renderer/fleaMarketContract.integration.test.ts`
- Create: `/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-flea-market-self-check.md`
- Create: `/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-flea-market-bugs.md`
- Modify: `/Users/yang/Desktop/otto-new/docs/code-map.md`
- Modify: `/Users/yang/Desktop/otto-new/docs/product-modules.md`
- Test (Create): `/Users/yang/Desktop/otto-new/packages/server/src/modules/park_services/flea_market/fleaMarketEndToEnd.integration.test.ts`

**PRD 验收对应：** A01–A40。

**Step 1: 写一个失败测试。** 按下列次序逐条完成红绿循环，不一次写完所有实现：

- E1 卖家发布真实图→E2 买家咨询→卖家回复→预留→修改时间→交接后售出→双方历史可读；Q 园区旁观者全程不可读。
- 真实服务器重启、断网重试、两账号/两窗口、状态并发、管理员治理和退出园区流程完整走通。
- 真实 macOS/Windows HEIC、键盘/1024×768/125%/150%、图片鉴权与性能基线逐项留证。

**Step 2: 运行刚写的测试，确认预期失败。** 从仓库根目录运行：

```bash
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market/fleaMarketEndToEnd.integration.test.ts
```

预期：新规则尚未实现导致对应断言失败。首次新增模块可能是导入不存在；建立最小模块后，应看到业务断言失败，不能把 native/配置错误当成有效红测。

**Step 3: 实现当前测试所需的最小行为。** 下面各条是独立实现动作，按涉及的测试逐条完成：

- 整合 A01–A40 覆盖矩阵，每条写实现文件、自动测试名/实际命令、运行结果、人工证据和状态；不是检查有没有某个函数名。
- 真实 SQLite/PostgreSQL 运行同套 API 契约与竞态；测试需涵盖实际 IPC/客户端接入，不只渲染 mock 数据。
- 性能用隔离测试库生成 10 万历史/1 万活跃、100 并发会话请求；记录网络条件、分位数及瓶颈，不能用几条数据代替 PRD 容量验证。
- 建立 bug 台账并修复本次缺陷后重测；缺 Windows/真实数据库/对象存储等环境则写未验证及精确复现命令，继续完成不依赖它的工作，功能仍保持不对生产开放。
- 刷新 code-map 与模块边界文档，记录权限/数据迁移/运行配置/任务恢复/容量与上线责任人；不要把缺依赖改为模拟成功。

**Step 4: 运行同一命令确认绿色。** 预期：本任务所有新增断言通过，无未说明 skip；涉及真实数据库或平台而缺环境时记录未验证，不伪报通过。随后只扩展到本次实际影响的已有测试。

**Step 5: 检查差异并保存检查点。** `git diff --check` 后，按 Files 精确暂存本任务创建的文件；共享已修改文件逐 hunk 检查，只提交自己的变更。建议本地提交信息：`test: verify flea market delivery`。不 push；若无法隔离他人改动，记录完成文件/验证结果而暂缓 commit。

## 6. 全局验证命令与预期

所有命令均为**未来执行者运行**，本轮没有执行。当前终端工作目录必须是 `/Users/yang/Desktop/otto-new`，如使用等价 worktree 则是其根目录。先核对 package scripts 未变；不要用根 Vitest 默认配置误跑桌面 jsdom。

```bash
npm run doctor
git diff --check
npm exec --workspace=packages/server -- vitest run src/modules/park_services/flea_market
npm exec --workspace=packages/server -- vitest run src/modules/collaboration/parkMarketConversation.test.ts
npm exec --workspace=packages/desktop -- vitest run src/renderer/components/flea-market src/main/park-flea-market-client.test.ts src/renderer/fleaMarketContract.integration.test.ts
npm run typecheck --workspace=packages/server
npm run typecheck --workspace=packages/desktop
npm run code-map
npm run code-map:check
npm run validate:boundaries
```

预期：针对性测试、两包 typecheck、代码地图和边界校验全部通过；记录实际数量及日志。doctor 原有容量问题不能被标为通过，但可继续收集独立检查证据。桌面 typecheck 的 prehook 会构建 native；平台/工具链缺失要记录真实错误。新增两种数据库合同测试要在各自真实环境运行，不能只列命令。

必要的回归（按实际修改范围补充精确文件）：

```bash
npm exec --workspace=packages/desktop -- vitest run src/renderer/components/InboxPage.test.tsx src/renderer/components/AccountManagementPage.test.tsx src/renderer/components/ParkServicesPlugin.test.tsx src/renderer/enterpriseUnreadNotifications.test.ts src/main/enterprise-mls-private-messages.test.ts
npm exec --workspace=packages/server -- vitest run src/modules/park_services/parkMembershipRepository.test.ts src/modules/data_platform/attachmentStorageService.test.ts
npm run build --workspace=packages/server
npm run build --workspace=packages/desktop
```

新增/改动的服务端私信回归文件由 Task 0 用 `rg` 精确查到后加入执行日志，不伪造存在的文件名。最终对新增目录及触及文件运行现有 ESLint；如果需要新增解码依赖，构建/双端安装验证不能省略。不要为了缩短等待关闭安全测试或把库异常 catch 成成功。

## 7. 最终自查与交付物

执行者须创建（现在尚未生成）：

1. `/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-flea-market-self-check.md`：F01–F07 与 A01–A40 两张覆盖矩阵。每行包含编号、真实行为、实现文件、测试文件/测试名/命令、运行结果、人工证据链接、状态（通过/失败/未验证/外部阻塞）。功能字段表与非功能要求也要检查，不能只覆盖 A 编号标题。
2. `/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-flea-market-bugs.md`：实际发现的缺陷，每条写 ID、严重性、复现前提和步骤、预期/实际、根因、修复位置、复测证据；没有缺陷如实写未发现，不为填表捏造。未解决条目不能删掉。
3. `/Users/yang/Desktop/otto-new/docs/research/2026-09-08-park-flea-market-execution-log.md`：基线、任务完成状态、本地提交（如有）、实际命令与结果、环境限制、配置方法和剩余工作。后续接手先读它，不能重置用户代码。
4. `/Users/yang/Desktop/otto-new/docs/plans/2026-09-08-park-flea-market-technical-decisions.md`：保留 Task 0 的选择、真实接入路径、消息/附件安全模式、迁移与worker运维方案。

最终至少自问：

- 真实两个不同企业账号是否能从发布一路走到回复、预留、售出？统一消息与应用重启后是否仍可找回？
- 第三个无关账号、另一园区、普通企业管理员、停用账号是否都被正确限制？是否有同企业私信/MLS回归？
- 是否所有图片入口、历史快照、分享、收藏与治理证据都执行各自最新权限？撤权后旧地址还能否读？
- 是否真正运行过 HEIC/macOS/Windows、真实 PostgreSQL、重启恢复、并发最后额度、超时重复请求？未运行的为何仍不能算完成？
- 预留跨期、误下架恢复、请求终止不复活、售出过期撤销、历史按商品、180 天内容清理等 v1.1 规则是否逐条有证据？
- 手机扫码、支付等延期项是否没有误占首发工期？首发必需的举报和管理入口是否没有被当作“以后再说”？
- 是否存在 TODO 空按钮、内存列表代替持久化、mock返回成功、未注册 worker、漏接集群、遗漏 IPC 或未复核的迁移？

完成判定：只有已实现并有运行证据的项才标通过；剩余缺陷需修复重测。代码完成但缺真实 Windows/存储/运营配置时，应表述为“代码完成，以下验收或上线条件未完成”，保持生产功能关闭，不能声称完整上线。报告最后列出改动、验证结果、未通过/未验证项及下一步，不用“基本完成”掩盖缺项。
