# Otto Skill 依赖声明与授权契约

只在 Skill 确实需要外部运行时或包时读取本文件。普通知识型 Skill 不要为了形式声明依赖。

## 机器可读声明

在 `SKILL.md` frontmatter 中使用 `runtimeDependencies`。`dependencies` 仍表示其他 Otto Skills，不能拿来声明 Python、Node 或软件包。

```yaml
runtimeDependencies:
  - id: node
    kind: command
    minimumVersion: "20"
    purpose: 运行演示文稿渲染和组装脚本
    source: https://nodejs.org/
    installScope: system
    installCommands:
      win32: winget install --id OpenJS.NodeJS.LTS --exact
      darwin: brew install node@20
      linux: sudo apt-get install nodejs npm
  - id: pptxgenjs
    kind: node-package
    minimumVersion: "4.0.1"
    purpose: 生成可打开的 PPTX 文件
    source: https://www.npmjs.com/package/pptxgenjs
    installScope: project
    installCommand: npm install --save-exact pptxgenjs@4.0.1
```

字段含义：

- `id`：命令名或包名；命令目前只支持 `node`、`npm`、`python`、`git`。
- `kind`：`command`、`node-package` 或 `python-package`。
- `minimumVersion`：可选，只写数字版本，不写模糊的 `latest`。
- `purpose`：面向用户解释为什么需要，不能只写“必需依赖”。
- `source`：官方 HTTPS 页面；不要写镜像站、网盘或短链接。
- `required`：默认 `true`。设为 `false` 时必须存在不安装也能工作的降级路径。
- `installScope`：优先 `skill`，其次 `project`；只有运行时本身无法隔离时才使用 `system`。
- `installCommand`：跨平台相同的准确命令；不同平台使用 `installCommands`。
- `platforms`：依赖只适用于特定系统时才填写，如 `[win32]`。

Otto 只用内置固定探测器检查这些类型，不执行 Skill 声明的自定义检查命令。这样第三方 Skill 不能借“检查依赖”运行任意代码。

## 授权对话

只读预检发现必需依赖缺失或版本过低后，调用 `ask_user_question`。一轮问题只做一个决定，推荐安全范围更小的选项：

- `安装到 Skill 环境（推荐）`：与其他项目隔离，并说明占用空间和安装位置。
- `安装到当前项目`：适合项目已有锁文件或依赖管理器。
- `不安装`：使用明确的降级能力，或停止并说明无法完成的部分。

问题正文必须展示：缺失项、检测结果、用途、官方来源、安装范围、准确命令、预计下载量或磁盘占用（能可靠取得时）。不要把多个互不相关的系统级安装捆绑成一次同意。

用户选择安装只是批准该依赖计划，不等于批准发布、登录账号、上传数据、运行管理员命令或安装其他推荐包。真正执行下载或安装时继续使用 Otto 的命令确认；命令与用户看到的不一致时重新询问。

## 安装后的闭环

1. 以用户批准的范围执行，不自动改为全局安装。每个确认项只包含一条可审计命令，不使用命令串联、`curl | sh`、`wget | bash`、编码 PowerShell、递归删除或来源不明的二进制。
2. 安装后重跑同一个只读预检，记录实际版本和解析路径。
3. 预检仍失败时最多做一次无破坏性诊断；不要循环重装。
4. Skill 完成后保留锁文件或依赖清单。临时虚拟环境只有在用户要求清理，或创建时已明确约定自动清理，才可删除。
5. 更新和卸载依赖是新的状态变更，不能沿用之前的安装授权。

## 降级要求

可选依赖缺失时，直接选择已声明的降级路径，不弹出阻断问题。必需依赖被用户拒绝时：

- 清楚列出不能完成的能力；
- 提供确实可行的零依赖或已有工具方案；
- 不用空文件、假截图、占位产物冒充完成；
- 不静默切换到会上传用户数据的云端服务。
