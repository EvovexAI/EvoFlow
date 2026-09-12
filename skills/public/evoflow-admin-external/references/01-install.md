# 安装与下载（治理技能包）

> **还没有 EvoFlow / `evoflow` 命令？** 先做完 [`00a-desktop-setup.md`](00a-desktop-setup.md)（下载桌面端 → 配模型 → 检测 CLI），再回到本页装技能包。

本技能按 EvoFlow **官方技能包格式**分发：

```text
evoflow-admin-external-1.0.0.zip   ← 推荐（Gateway / CLI 安装认 .zip）
└── evoflow-admin-external/
    ├── SKILL.md                   ← 必需
    ├── VERSION
    ├── CHANGELOG.md
    ├── LICENSE.txt
    ├── references/
    ├── examples/
    └── scripts/
```

`.skill` 与 `.zip` **内容相同**（均为 ZIP）；当前 EvoFlow 安装器对本地上传/路径安装以 **`.zip` 为准**。若只拿到 `.skill`，可改名为 `.zip` 再装。

---

## 1. 获取包（选一种）

### A. 官网首页下载（推荐给终端用户与 Agent）

首页区块锚点：`/#skill-pack`  
静态文件（与官网同源）：

```text
/skills/downloads/evoflow-admin-external-1.0.3.zip
/skills/downloads/evoflow-admin-external-1.0.3.skill
/skills/downloads/SHA256SUMS.txt
```

完整 URL = `https://<你的官网域名>` + 上表路径。首页可「下载 .zip」或「复制下载链接」；也可「复制给 Agent 的提示」。

Work Body / runtime 可被提示：

```text
从官网 /skills/downloads/evoflow-admin-external-1.0.3.zip 下载，校验 SHA256 后安装到 EvoFlow。
```

### B. 从本仓库源码目录使用（开发者）

源码树（未打包）：

```text
https://github.com/EvovexAI/EvoFlow/tree/main/skills/public/evoflow-admin-external
```

### C. 自己打包

在仓库根或技能目录执行：

```bash
python skills/public/evoflow-admin-external/scripts/package_release.py
```

产物默认写到本机临时/指定目录（`--out`；见脚本帮助）。**不要**把 zip 提交回公开源码树。

---

## 2. 安装到 EvoFlow（装完 Agent 才能「用技能」）

### 方式 1：CLI（适合 runtime / 脚本）

```bash
# 下载后：
evoflow skills install ./evoflow-admin-external-1.0.0.zip

# 若已有同名自定义技能，需先删除再装，或换版本名策略由管理员处理
evoflow skills get evoflow-admin-external
evoflow skills enable evoflow-admin-external
```

落盘位置：

```text
<skills 根>/custom/evoflow-admin-external/
```

（`EVOFLOW_SKILLS_PATH` 可覆盖根目录；frontmatter `name` 决定目录名，不是 zip 文件名。）

### 方式 2：面板

侧栏 **智能体 → 技能 → 导入本地**，选择 **`.zip`**。

### 方式 3：Gateway HTTP

```bash
# 面板/上传通道使用 multipart，扩展名须为 .zip
curl -s -X POST "$EVOFLOW_GATEWAY_URL/api/skills/install-local" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@evoflow-admin-external-1.0.0.zip"
```

### 方式 4：解压到 custom（无安装器时）

```bash
# 解压后确保路径为：
#   skills/custom/evoflow-admin-external/SKILL.md
```

然后在面板启用，或重启 Gateway 使技能缓存刷新。

---

## 3. 给 外部 Agent / CLI 宿主

这些环境**不一定**走 EvoFlow 安装器，但仍应使用**同一份目录内容**（官方 SKILL.md 约定）：

| 产品 | 建议 |
|------|------|
| **EvoFlow 本机 + 外部 Agent 调 CLI** | 先按 §2 装进 `skills/custom/`，再用 shell 跑 `evoflow` |
| **runtime / Claude Code skills 目录** | 将解压后的 `evoflow-admin-external/` **整夹复制**到该产品的 skills 目录（勿软链） |
| **Work Body** | 配置技能包下载 URL → 拉取 zip → 解压到其约定 skills 路径；执行说明以本包 `references/` 为准 |

给 Agent 的最短指令示例：

```text
1. 下载 https://…/evoflow-admin-external-1.0.0.zip
2. 用 SHA256SUMS.txt 校验
3. evoflow skills install <zip路径>
4. 读取已安装技能的 SKILL.md 与 references/01-install.md、03-cli-cheatsheet.md
5. 先跑 evoflow models list 确认 CLI 可用，再按用户目标编排
```

---

## 4. 安装后必做

见 [`02-version-check.md`](02-version-check.md)。

前置：本机已按 [`00a-desktop-setup.md`](00a-desktop-setup.md) 装好桌面端，且 `evoflow models list` 冒烟通过。派发员工 / 审批执行时 Gateway（桌面端）需在运行。
