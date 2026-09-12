# 发布方：官网挂载与分发约定

本文给 Evovex / 官网 / Release 维护者，说明**如何把本包变成用户与 Agent 可下载的地址**。

## 1. 官方包格式（与 EvoFlow 安装器对齐）

| 产物 | 说明 |
|------|------|
| `evoflow-admin-external-<ver>.zip` | **主分发**；面板与 `evoflow skills install` / `install-local` 认 zip |
| `evoflow-admin-external-<ver>.skill` | 同内容 ZIP，扩展名 `.skill`（社区/文档习惯名） |
| `SHA256SUMS.txt` | 上述文件的 SHA-256 |
| 源码目录 | `skills/public/evoflow-admin-external/`（本仓库，非软链） |

打包：

```bash
python skills/public/evoflow-admin-external/scripts/package_release.py \
  --out "${EVOFLOW_RELEASE_OUT:-./.tmp/skills-dist}"
```

`EVOFLOW_RELEASE_OUT` 由维护者本机或 CI 设置；不要写死盘符，也不要把产物提交进公开源码树。
## 2. 官网首页挂载（已接线）

静态文件目录（提交进仓库）：

```text
website/apps/web/public/skills/downloads/
  evoflow-admin-external-<ver>.zip
  evoflow-admin-external-<ver>.skill
  SHA256SUMS.txt
```

对外 URL：

```text
https://<官网>/skills/downloads/evoflow-admin-external-<ver>.zip
https://<官网>/#skill-pack
```

首页文案与按钮：`website/packages/content/src/home-landing.ts` → `skillPack`；链接常量：`site-links.ts` 的 `adminExternalSkill*`。

发新版本时：

1. 改 `VERSION` / frontmatter / CHANGELOG  
2. `python …/package_release.py`（默认同步到 `public/skills/downloads/`）  
3. 同步改 `siteLinks.adminExternalSkillVersion` 与三个路径里的版本号  
4. 部署官网

## 3. 给 Agent 的「可复制提示」模板

挂在官网按钮旁，供用户粘贴给 runtime / Work Body：

```text
请安装 EvoFlow 外部治理技能包：
1. 下载 <ZIP_URL>
2. 用 <SUMS_URL> 校验 SHA256
3. 执行：evoflow skills install <本地zip路径>
4. 执行：evoflow skills enable evoflow-admin-external
5. 阅读已安装目录下 SKILL.md 与 references/，用 evoflow CLI 管理我的平台
```

## 4. 版本发布检查清单

- [ ] 更新 `VERSION`、`SKILL.md` 的 `version:`、`CHANGELOG.md`
- [ ] 跑 `package_release.py`，确认 zip 内顶层目录名为 `evoflow-admin-external/`
- [ ] 在干净环境 `evoflow skills install` 一次并跑 `02-version-check.md`
- [ ] 上传 zip + skill + SHA256SUMS 到 CDN / Release
- [ ] 更新官网下载区 URL 与提示文案
- [ ] （可选）同步 SkillHub 条目，slug 与 `metadata.slug` 一致

## 5. 不要做的事

- 不要用软链接指向仓库其它技能再打包（解压机可能没有链目标）。
- 不要只发裸 `SKILL.md` 单文件当「安装包」。
- 不要在未改名的情况下指望所有通道都能吃 `.skill`（**安装通道优先 zip**）。
