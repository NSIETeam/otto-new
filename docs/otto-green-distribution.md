# Otto Green 独立分发

Otto Green 与普通 Otto 使用同一套业务源码，但拥有独立安装和更新身份。Green 不是通过重命名普通安装包实现，
也不会读取普通 Otto 的 `latest.json`。

## 稳定身份

- 分发识别码：`otto-green`
- 产品名：`Otto Green`
- 界面字标：`otto.green`
- Windows appId/AUMID：`ai.otto.green.desktop`
- 协议：`otto-green://`
- 本地配置目录：`Otto Green`
- 用户工作目录：`~/.otto-green-user`
- 本地 server 默认端口：`7638`

普通 Otto 继续使用原有 appId、`~/.otto-user`、7637 端口和 `otto://` 协议。因此两个版本可以同时安装和运行。

## 更新隔离

Green 只检查：

    https://59.110.154.44:7777/otto-green-releases/latest.json

安装包托管在：

    https://59.110.154.44:7777/downloads/otto-green/

Green 清单必须包含 `"distributionId": "otto-green"`。普通清单缺少该值或声明为 `otto` 时，Green 客户端
fail-closed，不会下载；普通 Otto 收到 Green 清单时同样拒绝。Green 不回落到普通 Otto 的 GitHub latest release。

## 构建与部署

Windows 本地构建：

    npm run release:green:win --workspace=packages/desktop

输出位于 `packages/desktop/release-green/`：

- `Otto.green-<version>.exe`
- `Otto.green-<version>.exe.blockmap`
- `latest.json`

GitHub Actions 的 `Release Otto Green` 工作流为手动触发，只写服务器的 `otto-green` 子目录；普通 Otto 的
`/downloads` 和 `/otto-releases/latest.json` 不会被覆盖。未来两条发布流程合并时，仍应保留分发识别码和清单
匹配校验，不能仅按文件名区分。
