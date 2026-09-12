# 版本与完整性校验

发行版在 frontmatter、`VERSION`、`CHANGELOG.md` 三处声明同一语义版本（当前：**1.0.0**）。

## 1. 下载后校验（安装前）

发布物旁应有 `SHA256SUMS.txt`，例如：

```text
<hex>  evoflow-admin-external-1.0.0.zip
<hex>  evoflow-admin-external-1.0.0.skill
```

### Windows (PowerShell)

```powershell
Get-FileHash -Algorithm SHA256 .\evoflow-admin-external-1.0.0.zip
# 与 SHA256SUMS.txt 中对应行比对
```

### macOS / Linux

```bash
shasum -a 256 evoflow-admin-external-1.0.0.zip
# 或：sha256sum -c SHA256SUMS.txt
```

哈希不一致：**不要安装**。

## 2. 安装后核对身份

```bash
evoflow skills get evoflow-admin-external
```

CLI 当前可能只返回 name / description / enabled 等字段，**不一定带出版本号**。请再读落盘文件：

```bash
# 典型路径（按本机 skills 根调整）
# Windows: %USERPROFILE%\.evoflow\… 或安装目录下 skills\custom\
# 开发树: <repo>/skills/custom/evoflow-admin-external/

# 查看 frontmatter version 与 VERSION 文件
```

PowerShell 示例：

```powershell
Get-Content (Join-Path $env:USERPROFILE '.evoflow\skills\custom\evoflow-admin-external\VERSION')
Select-String -Path (Join-Path $env:USERPROFILE '.evoflow\skills\custom\evoflow-admin-external\SKILL.md') -Pattern '^version:'
```

期望：`VERSION` 内容为 `1.0.0`，且与 `SKILL.md` 中 `version:`、`CHANGELOG.md` 最新节一致。

## 3. 功能冒烟（验「能管平台」）

```bash
evoflow models list
evoflow agents list
evoflow skills list --enabled-only
```

若 `skills get` 找不到本技能：未装到 `custom/`、未启用、或 skills 根路径不对（检查 `EVOFLOW_SKILLS_PATH`）。

## 4. 升级策略

EvoFlow 对同名技能安装会报「已存在」，不会自动按 semver 覆盖。升级建议：

1. 记下旧版 `VERSION`
2. `evoflow skills delete evoflow-admin-external`（仅 custom 可删）
3. `evoflow skills install` 新 zip
4. 再跑本节 §2–§3

内置 `skills/public/` 中的副本随产品升级更新；**官网下载的发行包**应装到 `custom/`，以便独立升级。
