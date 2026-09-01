---
name: ppt-creator
version: 10
description: 直接使用 Ultimate PPT Master v6.1 作为 PPT 生成引擎。AI 手写 SVG → svg_to_pptx.py → 原生可编辑 .pptx。
runtimeDependencies:
  - id: git
    kind: command
    purpose: 首次取得用户指定的 Ultimate PPT Master 源码
    source: https://git-scm.com/
    installScope: system
    installCommands:
      win32: winget install --id Git.Git --exact
      darwin: brew install git
      linux: sudo apt-get install git
  - id: python
    kind: command
    minimumVersion: "3.10"
    purpose: 运行 SVG 检查、后处理和 PPTX 导出脚本
    source: https://www.python.org/downloads/
    installScope: system
    installCommands:
      win32: winget install --id Python.Python.3.12 --exact
      darwin: brew install python@3.12
      linux: sudo apt-get install python3 python3-pip python3-venv
---

# 🎬 Otto PPT — Ultimate PPT Master 引擎

当用户要求制作 PPT 时，使用 [Ultimate PPT Master v6.1](https://github.com/kdnsna/ultimate-ppt-master-skill) 作为核心引擎。

---

## 🔧 首次使用（一次性）

先只读检查仓库、Python 和依赖是否已经存在。若缺少任何一项，必须先调用 `ask_user_question`，说明将从哪个官方地址下载、安装到哪里、用途和准确命令；只有用户明确同意后才能执行下面的克隆或安装。使用 PPT Skill 本身不等于授权下载依赖。

```bash
# 克隆 PPT Master 仓库
git clone https://github.com/kdnsna/ultimate-ppt-master-skill.git ~/.otto-ppt-master

# 安装 Python 依赖
cd ~/.otto-ppt-master && pip install -r requirements.txt
```

如果已克隆过，更新仓库同样属于联网变更；先询问用户是否更新，再执行：

```bash
cd ~/.otto-ppt-master && git pull --ff-only
```

---

## 🚀 每次做 PPT 的完整流程

严格按照 PPT Master 的 SKILL.md（`~/.otto-ppt-master/SKILL.md`）执行 Step 1–7。以下是简化版快速参考：

### Step 1: 任务摄入

确认：
- 谁，听完后理解/相信/决定什么？
- 受众场合？
- 品牌约束？（有现成 PPTX 则先学习）

### Step 2: Best-Effect Brief

运行路由：
```bash
python ~/.otto-ppt-master/scripts/best_effect_router.py "<用户的原始请求>"
```

创建项目目录：
```bash
mkdir -p ~/.otto-ppt-master/projects/<project_name>/svg_output
mkdir -p ~/.otto-ppt-master/projects/<project_name>/notes
mkdir -p ~/.otto-ppt-master/projects/<project_name>/images
mkdir -p ~/.otto-ppt-master/projects/<project_name>/exports
```

写 `project-brief.json` 和 `storyboard.json`（记录 slideId、page role、layout、claim）。

### Step 3: 参考 PPTX（如有）

```bash
python ~/.otto-ppt-master/scripts/pptx_template_import.py <reference.pptx> --manifest-only --reference-style-mode style-only
```

### Step 4: 策略师 — 设计规格

写 `design_spec.md` 和 `spec_lock.md`（≤120行），锁定：
- 视觉方向（6选1）
- 色板、字体、页面角色、布局、抗模式

### Step 5: 图片（如需要）

```bash
python ~/.otto-ppt-master/scripts/build_asset_plan.py <project_path>
python ~/.otto-ppt-master/scripts/image_gen.py --asset-plan <project_path>/asset_plan.json
```

### Step 6: 执行器 — AI 手写 SVG

**这是核心步骤**。AI 逐页手写 SVG 到 `svg_output/` 目录。

每一页 SVG 规格：
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <!-- background -->
  <!-- midground -->
  <!-- foreground text / shapes -->
</svg>
```

关键约束：
- 必须 `viewBox="0 0 1920 1080"`
- 文字用 `<text>` 元素而非 `<foreignObject>`（后者 PPT 不兼容）
- 颜色从 `spec_lock.md` 取
- 每生成一页，运行质量检查：
```bash
python ~/.otto-ppt-master/scripts/svg_quality_checker.py <project_path>
```

生成讲者备注到 `notes/total.md`。

### Step 7: 后处理 & 导出

**逐条执行，不合并：**

```bash
# 7.1 拆分备注
python ~/.otto-ppt-master/scripts/total_md_split.py <project_path>

# 7.2 SVG 后处理
python ~/.otto-ppt-master/scripts/finalize_svg.py <project_path>

# 7.3 导出 PPTX
python ~/.otto-ppt-master/scripts/svg_to_pptx.py <project_path>
```

产物在 `projects/<project_name>/exports/` 目录。

---

## ⚡ 快速通道（用户说"快"时）

如果用户明确要速度，跳过 Step 4–5，直接用默认 visual direction 走 Step 6：

- Visual direction: `dark-professional`（深色专业风）
- 8 页标准节奏
- 不生成图片，纯矢量 SVG
- 不写 design_spec.md，直接在代码里声明 spec_lock

---

## 🛡️ 降级

| 场景 | 响应 |
|------|------|
| PPT Master 未克隆 | `⚠️ 需要先 git clone https://github.com/kdnsna/ultimate-ppt-master-skill.git` |
| pip 依赖不全 | `⚠️ 需要 pip install -r ~/.otto-ppt-master/requirements.txt` |
| svg_to_pptx.py 报错 | 检查 svg_output/ 中存在*.svg且 viewBox正确 |
| 缺素材 | 生成 `Needs-Manual` 占位符，不假完成 |

---

## 📦 交付

- [ ] `.pptx` 在 `exports/` 目录，可打开
- [ ] 文字在 PowerPoint 中可编辑
- [ ] `storyboard.json` 记录所有页
- [ ] 如有 Needs-Manual 项，明确列出
