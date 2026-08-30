# 历史 GitHub Actions 发布说明（已归档）

> 本页描述的是 Otto 旧仓库、旧分支和旧制品流程，禁止用于当前发布、部署或事故恢复。

当前唯一权威发布资料：

- [发布前检查](./release-preflight.md)
- [当前工作流说明](../.github/workflows/README.md)
- [企业一键包与 root 网关](../deployment/enterprise-oneclick/README.zh-CN.md)

正式版本只能由 `NSIETeam/otto-new` 的锁定 `origin/internal` 提交通过
`.github/workflows/release.yml` 生成。不得恢复本页历史版本中的“跳过失败测试”、
“人工编辑或删除 Release 资产”、“把已公开 Release 退回草稿”、“注释发布步骤”或从旧
分支直接发布等做法。当前流程会在第一次 tag/Release 写入前保存并上传 SHA-256 绑定的
完整创建意图和双仓
`latest` 快照，先公开正式仓、最后公开兼容仓；失败补偿只精确恢复此前 `latest`，任何
曾公开的版本都视为永久烧毁。
