# Otto 文档运行时组件契约

默认桌面安装包保持轻量，不直接包含 Python、Node.js 和 LibreOffice。企业发行版或
独立文档运行时组件从以下目录读取各平台运行时：

`packages/desktop/vendor/runtime/<platform>-<arch>/`

需要生成带完整文档能力的企业发行物时，必须具备以下布局；任一缺失，运行时组件
校验必须失败，不允许用占位文件冒充完整能力。

- macOS/Linux Python：`python/bin/python3`
- Windows Python：`python/python.exe`
- Python 模块：`python/site-packages/docx`、`jinja2`、`markdown`
- macOS/Linux Node.js：`node/bin/node`
- Windows Node.js：`node/node.exe`
- macOS LibreOffice：`libreoffice/LibreOffice.app/Contents/MacOS/soffice`
- Windows/Linux LibreOffice：`libreoffice/program/soffice[.exe]`

这些大型二进制不以占位文件冒充。构建环境必须先按平台提供经过审核的真实运行时；
`scripts/verify-document-runtime.mjs` 负责独立组件的静态完整性闸门。若发行渠道选择把
组件随安装包交付，只允许复制当前 `${platform}-${arch}` 目录，不得把 macOS 双架构和
Windows 多套大型运行时同时塞进一个安装包。

运行时解析顺序固定为：

1. `process.resourcesPath/runtime/<platform>-<arch>`（或测试/调试用
   `OTTO_RESOURCES_PATH`）；
2. 开发版/CLI 的系统 `PATH` 作为兼容回退。

内置 Python 会设置自己的 `PYTHONPATH` 和 `PYTHONNOUSERSITE=1`，避免依赖用户机器
临时安装的包而出现“这台电脑能用、另一台不能用”的差异。

## 智能招聘音频组件

智能招聘的 PDF/DOCX 解析复用上述文档运行时。WhisperX 音频转写属于独立的大型企业
组件，不进入默认轻量安装包。正式启用“音频面试分析”的发行物必须在同一 Python
运行时的 `python/site-packages` 中离线安装
`packages/desktop/runtime/recruitment/requirements.txt`，并随组件提供可执行的 FFmpeg。

- 当前固定稳定版：`whisperx==3.8.6`，Python `>=3.10,<3.14`；
- 说话人区分还需要配置只读 `HF_TOKEN`，并由发行/部署方确认已接受所使用的
  pyannote 模型条款；未配置时仍允许转写，但界面必须明确要求人工确认说话人；
- 审计记录必须保存实际 WhisperX 模型名，不允许只记录“AI 分析”；
- 运行时缺失或加载失败时必须显式报错，禁止伪造转写或静默回退为未知模型。
