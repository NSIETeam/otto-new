# 桌宠黑底修复（2026-09-11）

## 已确认原因

桌宠由 renderer/index.tsx 单独懒加载，不再加载 App.tsx；但透明背景、命中区定位和 sprite 定位仍全部依赖 App 才导入的 app.css。共用的 index.html 又为 body 设置了 #181818。原生 BrowserWindow 的 transparent:true 不能抵消网页自己画出的不透明背景。

修复前用实际生产 renderer 构建、隔离 Electron 窗口复现：body 背景为 rgb(24,24,24)，命中区 position 为 static，底部空隙约 56 CSS 像素。不是根据截图猜测 GPU 缓存故障。

## 修改

- 新增 desktop-pet.html：首帧即透明，固定透明画布使用 light color-scheme，不继承主界面黑底；主窗口仍用原来的 index.html。
- DesktopPetSurface 自己导入独立 CSS，并补齐原来间接继承的 motion/sprite 样式。删除 app.css 中同一套桌宠样式，避免重复实现再次漂移。
- 主进程桌宠加载新页面，构建与安装包内容校验纳入该页面，漏打包直接报错。
- 未改拖动算法、动画帧、桌宠位置保存或企业功能；未清理用户缓存、聊天资料，也未全局禁用硬件加速。

## 验证方式

在 packages/desktop 运行（需安装依赖并先构建 renderer）：

```powershell
node ../../node_modules/webpack-cli/bin/cli.js --config webpack.config.cjs --mode production
node ../../node_modules/vitest/vitest.mjs run scripts/desktop-pet-entry.test.mjs scripts/packaging-contract.test.mjs src/renderer/components/DesktopPetSurface.test.tsx src/renderer/components/OttoPetStage.test.tsx src/main/desktop-pet-drag.test.ts --maxWorkers=2
node scripts/verify-desktop-pet-surface.cjs
node scripts/verify-desktop-pet-surface.cjs desktop-pet.html --software
```

smoke 使用真实构建的懒加载组件和 Electron 页面，只有 IPC 桥接使用无服务器的测试替身。每次使用新的临时 profile、隐藏窗口，不接触已安装 Otto 的数据。验证浅/深主题的 html/body/root 透明背景、112×132 命中区、底部定位、无默认矩形焦点框、sprite 可见，以及实际帧角落的 alpha=0。软件渲染开关仅用于测试进程。截图和计算样式 JSON 保存在命令输出的临时证据目录。

本机默认渲染和软件渲染两条路径的浅/深主题像素测试均通过；不等于所有显卡、驱动和操作系统都已验证。生产 renderer 构建、相关类型检查与源码 lint 通过。

## 交付边界

这次是本地源码与构建修复，没有发布新安装包、改写正在运行的安装版、推送或重启生产服务器。正在运行的旧程序不会热更新这段主进程代码，需要使用包含本修复的新构建后生效。npm doctor 的既有 Windows npm.cmd 探针问题仍单独记录，不宣称全仓 doctor 通过。
