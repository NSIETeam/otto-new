# 智能招聘：浏览器授权与官方账号、岗位目录

日期：2026-09-08。目录：`D:/otto/otto-push-20260901`；分支：`internal`。

接续 [本人授权与岗位绑定](recruitment-workable-authorization-bindings-20260908.md)。本轮把浏览器授权代码接到 Electron 和企业服务器，完成受控模拟联调；没有使用真实 Workable 账号登录，不能因此将招聘来源标为生产可用。

## 用户可检查的变化

1. 智能招聘 → 候选人来源 → Workable，先点击“刷新本人授权”。服务器开启本轮能力后，会显示“在浏览器登录 Workable”。
2. 用户确认后，桌面端打开系统浏览器中的官方授权页。仅申请 `r_account`、`r_jobs`、`r_candidates` 三项读取权限，不申请候选人写入、消息、Offer 或人员管理权限。
3. 浏览器返回本机临时回调端口。一次性授权码只经过 Electron 主进程和原企业服务器；PKCE verifier 与 access token 不返回渲染界面，也不要求用户粘贴密钥。
4. 企业服务器交换令牌，调用官方 `get_accounts` 和 `get_jobs`，读取本人账号下的已发布岗位。成功后回到原岗位绑定面板，由用户自己选择，禁止自动选择第一个账号或岗位。
5. 页面支持“取消本次登录”。取消、超时、退出工作台、切换企业或会话变化会停止本机授权流程；不会把旧授权码发到新的企业会话。若原会话已经失效而无法发送取消请求，服务端 pending 流程最多 10 分钟失效，不能继续完成。
6. 重新授权会清除原有岗位绑定，必须重新选择；取消未完成的登录不删除已有候选人档案，也不撤销已有的有效授权。需要彻底移除时仍使用“撤销本人全部授权”。

## 部署和验收开关

本轮没有改动本机运行服务的环境或生产配置。管理员需要在升级后的**企业服务器进程环境**中显式设置 `OTTO_WORKABLE_OAUTH_ENABLED=1` 并重启服务器，才能显示浏览器授权能力。该设置应先用于验收环境。

此开关只允许开始 OAuth，并不代表 Workable 来源通过真实验收。来源注册仍保留 `realAccountVerified` / `authorizationReference` 的独立审核门槛；上轮的 `resolveGrant` 仍需在部署组合中接到真实来源运行时。不能通过把测试桩标记为已验收来开放来源。

必须同时升级 server、Electron main、preload、renderer。远端企业服务器必须使用 HTTPS；本机开发只允许回环 HTTP。浏览器回调固定为 `http://127.0.0.1:<临时端口>/otto-workable-callback`，没有给企业服务器新增公网免登录回调接口。Web 客户端尚不使用该本机回调实现。

## 协议与状态保护

- 本轮实际只读获取并核对了官方 OAuth 元数据；没有创建真实 OAuth 客户端、提交真实授权或调用付费模型。
- 发现过程核对 issuer、resource、官方 authorization/token/registration endpoint、S256 和所需 scope。请求禁止跟随 HTTP 重定向，令牌仅发送到固定官方 MCP endpoint。
- 当前采用动态注册的 public client + Authorization Code + S256 PKCE。若平台未接受 `token_endpoint_auth_method=none`、所申请的回调或只读权限，会拒绝继续，不自动降级成弱认证或粘贴令牌模式。真实租户兼容性仍待验证。
- state、verifier、clientId、redirectUri、过期时间与当前阶段存入现有组织/账号隔离的加密记录；SQLite / PostgreSQL 共用条件写入修订号。没有仅保存在某一服务器内存里的授权事务。
- 开始前原子占用流程；每个账号一分钟内不能反复发起。回调先原子认领，再交换授权码；重复回调、异账号、旧 state、过期或撤销后的回调均失败。
- 网络调用前后重新检查当前企业账号和授权事务；最终落库再比较修订号。取消或注销期间迟到的结果无法恢复授权。
- 本机回调检查 Host、路径、state、重复参数及可选 issuer，默认只监听回环地址。响应禁止缓存、禁止引用来源和页面脚本，不回显授权码或平台原始错误。
- 授权接口响应使用 `Cache-Control: no-store`。审计继续只保留操作类型、修订号与必要作用域，不记录 state、verifier、授权码或 token。

## 明确限制

- **未进行真实账号验收。** 官方元数据能读取，不等于真实 DCR、同意页、回调及工具返回格式已验证。
- 本轮仅支持已发布岗位目录，最多 10 个账号、合计 100 个岗位。遇到需要进一步岗位分页、超限、未知返回结构或缺少工具参数时明确失败；不声称已经取回完整目录。工具清单分页有次数与大小限制。
- 不实现自动续期，不存储 refresh token；授权到期后重新登录。没有平台侧 revoke 调用，移除 Workable 平台上的授权仍需在平台管理。
- 没有新增候选人联系、自动淘汰、Offer 决策或后台招聘轮询；没有实际读取候选人材料或触发模型分析。本轮授权和目录查询不增加模型 Token 消耗，但会产生平台接口请求。
- 原始简历托管、Word/OCR 等仍以上轮说明为准；PostgreSQL 的本轮验证仍是 SQL 契约，不是实际集群验收。
- 开始授权时动态注册客户端，平台的注册配额、客户端缓存/复用要求和回调限制仍需真实账号验收；当前未做静默重试。

## 验证

新增失败测试后实现并复测，包括：官方元数据校验、只读 scope、PKCE/resource 一致性、错误回调、跨账号、取消、超时、迟到交换、重复回调、加密 pending 数据、本机 HTTP 回调、界面确认/取消、企业 HTTP 完整授权流程（模拟平台响应）。

最终回归共 **522 项通过**（43 个测试文件，无失败或跳过）：服务端招聘模块、企业 HTTP、权限与 PostgreSQL 仓库契约 322 项；桌面招聘、授权、本地回调、企业客户端、对话安全/并发及恢复 200 项。聚焦运行中的过滤跳过没有计入这组结果。真实平台、真实 PostgreSQL、生产性能与渗透验收不包含在这些本地结果中。

服务端独立 `tsc --noEmit`、桌面 main / preload / renderer 类型检查、相关 ESLint、renderer / preload 生产构建、preload 沙箱单文件检查、`git diff --check`、代码地图检查通过。完整依赖重建被工作区并行改动中的 `packages/core/src/tools/web-search.ts:226` / `:365` 阻断：`WebSearchToolResult.sources` 与新增 `ToolResult.sources` 类型不兼容；该改动不属于本轮招聘实现，没有擅自改写，因此不能将完整 core/server 依赖构建报告为通过。

本轮未暂存、提交或推送；工作区存在其他任务的未提交修改，均保留。

## 官方依据

- [Workable MCP](https://workable.readme.io/reference/workable-mcp-server)：官方端点、动态注册、账号选择与工具名称。
- [Workable 授权服务器元数据](https://mcp.workable.com/.well-known/oauth-authorization-server)、[保护资源元数据](https://mcp.workable.com/.well-known/oauth-protected-resource)：本轮于 2026-09-08 通过只读 HTTPS 请求获取，未携带凭据。
- [MCP Authorization 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)：资源绑定、PKCE 与令牌传递要求。
- [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)：动态注册；[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)：原生应用浏览器与本机回调。
