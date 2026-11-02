# 桌面版发版清单（必读）

每次升版本（如 `1.0.9` → `1.1.0`）按本文操作。  
**不要只改 `package.json`。** 正式构建会读 `evopanel/VERSION` 并回写各处；漏改 `VERSION` 会打出旧版本号。

---

## 1. 改版本号（一条命令）

单一版本源：`evopanel/VERSION`。

```bash
cd evopanel
npm run version:set -- 1.1.0
```

会同步：

| 文件 | 作用 |
|------|------|
| `evopanel/VERSION` | **唯一版本源**（构建前 `sync-version` 以此为准） |
| `evopanel/package.json` | Node / CI 读版本 |
| `evopanel/package-lock.json` | 根包版本字段 |
| `evopanel/src-tauri/Cargo.toml` / `Cargo.lock` | Rust / 安装包版本 |
| `evopanel/src-tauri/tauri.conf.json` | Tauri 应用版本 |
| `backend/pyproject.toml` | Gateway 包版本（与面板同一号） |
| `backend/packages/harness/pyproject.toml` | harness 包版本（与面板同一号） |
| `scripts/maintainer/update/latest.json` | 升级通道草稿的 `version` / `url`（**不会**重写 `changelog` 正文） |

前后端共用同一个 `x.y.z`，不要单独再升一号。核对：`cat evopanel/VERSION` 与上面几处版本字符串一致。

---

## 2. 写三份说明（缺一不可）

按 **自上一正式版 tag 到本次要打进包的提交** 写真实变更，不要套空话。

| # | 文件 | 给谁看 |
|---|------|--------|
| 1 | [`evopanel/CHANGELOG.md`](evopanel/CHANGELOG.md) | 仓库版本日志；新增 `## [x.y.z] - YYYY-MM-DD` |
| 2 | [`scripts/maintainer/windows/release-notes/PRODUCT-NOTES-x.y.z.md`](scripts/maintainer/windows/release-notes/) | GitHub Release「本版更新」；CI `build-release-body.py` **硬依赖** |
| 3 | [`scripts/maintainer/update/latest.json`](scripts/maintainer/update/latest.json) 的 `changelog` 字段 | 客户端升级横幅文案（浓缩一段话） |

写作约定见 [`evopanel/docs/changelog-guidelines.md`](evopanel/docs/changelog-guidelines.md)。

有用户可感知的新模块时，再补用户文档（指南 / `page-help`），见该文件说明。

---

## 3. 提交与打 tag

```bash
git add evopanel/VERSION evopanel/package.json evopanel/package-lock.json \
  evopanel/src-tauri/Cargo.toml evopanel/src-tauri/tauri.conf.json \
  evopanel/CHANGELOG.md \
  scripts/maintainer/update/latest.json \
  scripts/maintainer/windows/release-notes/PRODUCT-NOTES-x.y.z.md
# 若 Cargo.lock 的 package version 也变了，一并 add

git commit -m "chore(release): x.y.z"
git push origin HEAD

# 标签触发桌面发版 CI（.github/workflows/release-desktop-public.yml）
git tag v1.1.0
git push origin v1.1.0
```

也可在 GitHub Actions 里对 `release-desktop-public` 做 `workflow_dispatch`（需当前 `main` 上版本与说明已齐）。

---

## 4. 装包后刷新升级通道

客户端轮询（**Gitee 优先**，适合国内；再 jsDelivr / GitHub raw）：

- `https://gitee.com/evovexai/EvoFlow/raw/main/update/latest.json`
- `https://cdn.jsdelivr.net/gh/EvovexAI/EvoFlow@main/update/latest.json`
- `https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

安装包下载链接默认写 **Gitee Releases**（`url` / `urlGitee`），`urlGithub` 作海外回退。  
**务必把同名 `setup.exe` 也传到 Gitee 对应 tag**，否则国内点更新会下不到包。

**Windows CI（`release-windows-public.yml`）发完安装包后会自动推清单。** 本地/补推：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/maintainer/windows/push-public-latest-json.ps1 -Tag v1.2.3
# 只推国内：加 -SkipGithub
# 带本机 NSIS（含 nsis.zip+.sig 时写 platforms）：-NsisDir evopanel\src-tauri\target\release\bundle\nsis
```

也可用 `republish-public-release.ps1 -UpdateLatestJson`（重传安装包并推清单；设 `GITEE_REPO_TOKEN` 可同步 Gitee Release 资产）。

草稿在 `scripts/maintainer/update/latest.json`；**不要**在安装包未就绪时往公仓根目录塞假的 `update/`。

一键应用内更新还需要 CI secrets `TAURI_SIGNING_PRIVATE_KEY`（+ 可选 password），否则 Release 只有 `setup.exe`，清单无 `platforms`，客户端提示「下载安装包」。

---

## 5. 发版前自检（避免再打成旧版）

- [ ] `evopanel/VERSION` == 目标版本（不是只改了 package.json）
- [ ] 跑过 `npm run version:set -- x.y.z`（或确认 sync 后各处一致）
- [ ] `CHANGELOG.md` 有本版完整条目
- [ ] 存在 `PRODUCT-NOTES-x.y.z.md`（否则 Release 正文几乎只有页脚）
- [ ] `latest.json` 的 `version` / `url` / `changelog` 都是本版
- [ ] 已推送提交；将打的 `vX.Y.Z` tag 指向含上述文件的 commit
- [ ] GitHub Latest Release 版本号与安装包文件名一致

---

## 相关入口

| 文档 | 内容 |
|------|------|
| 本文 `RELEASE.md` | **升版要改什么（清单）** |
| [`scripts/maintainer/README.md`](scripts/maintainer/README.md) | 维护者脚本索引 |
| [`scripts/maintainer/windows/README.md`](scripts/maintainer/windows/README.md) | 本地一键发 Windows 包 |
| [`MAINTAINERS.md`](MAINTAINERS.md) | 谁负责发版 |
| [`.github/workflows/release-desktop-public.yml`](.github/workflows/release-desktop-public.yml) | 桌面 CI 入口 |
