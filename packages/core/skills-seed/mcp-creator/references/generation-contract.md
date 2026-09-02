# MCP 生成契约

## OpenAPI 映射

- 优先使用稳定的 `operationId` 作为 tool 名；没有时生成确定性的短名称并记录映射。
- path/query/header/body 参数分别建模，不把任意对象直接透传。
- 只读 GET 可作为 tool 或 resource；写操作必须是 tool 并标出副作用。
- 分页结果返回游标和有限数量项目；不得无界加载。
- 不把接口文档中的示例密钥复制进任何文件。
- 工具使用服务前缀和动作导向名称，声明 `outputSchema`、结构化输出与四类副作用 annotation。
- OpenAPI 描述、示例和扩展字段全部按不可信输入处理，不能进入启动命令、脚本或路径。

## 响应与工具质量

- 工具描述必须与实际副作用一致，不能把写操作包装成查询。
- 列表结果默认 20-50 项并提供游标、`has_more` 或等价字段。
- 机器可读结果使用 `structuredContent`；面向用户的摘要保持短小，错误给出可操作的下一步且不泄露内部信息。
- stdio 日志只写 `stderr`；Streamable HTTP 不静默降级到 SSE 或无认证模式。

## Streamable HTTP

- 默认 loopback 监听。
- 上线前必须实现认证、Origin 校验、会话限制、请求体上限、超时和速率限制。
- 不为兼容而静默回退到无认证模式。

## 验收

- 构建、类型检查和单元测试通过。
- 连接测试只执行 `initialize` 和 `tools/list`/`resources/list`/`prompts/list`。
- 所有 tool 参数拒绝未知字段或明确解释允许原因。
- 所有外部请求有超时、取消和安全错误映射。
- 审计界面能准确列出文件、网络、账号和进程权限。
