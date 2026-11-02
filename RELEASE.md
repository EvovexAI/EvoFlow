# 桌面版发版清单（必读）

每次升版本（如 `1.0.9` → `1.1.0`）按本文操作。  
**不要只改 `package.json`。** 正式构建会读 `evopanel/VERSION` 并回写各处；漏改 `VERSION` 会打出旧版本号。

---

## 现行路径（就这一套）

| 环节 | 怎么做 |
|------|--------|
| **打安装包** | 推 `v*` tag → **GitHub Actions** 自己编，挂到 **GitHub Releases** |
| **检查有无更新** | 客户端 **优先拉 Gitee** 上的 `update/latest.json`，再 jsDelivr / GitHub raw |
| **下载安装包** | 清单里的地址：国内用 `ghfast.top` 镜像 GitHub Release；海外可直连 GitHub |
| **刷新清单** | 装包上传后跑 `push-public-latest-json.ps1`（写 hash/size，推 GitHub + Gitee） |

Gitee **不能**托管 ~380MB 的 `setup.exe`（附件上限约 100MB），所以正式包不走 Gitee Releases。  
Gitee 只负责：**代码镜像** + **升级清单（小文件）**，让国内「检查更新」能通。

（曾探索过 Gitee Go 自建机 + 对象存储独立打包，**当前不启用**；见 [`scripts/maintainer/gitee/README.md`](scripts/maintainer/gitee/README.md)。）

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

## 3. 提交与打 tag（GitHub 打包）

```bash
git add evopanel/VERSION evopanel/package.json evopanel/package-lock.json \
  evopanel/src-tauri/Cargo.toml evopanel/src-tauri/tauri.conf.json \
  evopanel/CHANGELOG.md \
  scripts/maintainer/update/latest.json \
  scripts/maintainer/windows/release-notes/PRODUCT-NOTES-x.y.z.md
# 若 Cargo.lock 的 package version 也变了，一并 add

git commit -m "chore(release): x.y.z"
git push origin HEAD
# 可选：同步代码到 Gitee（不影响打包）
# git push gitee HEAD:main

# 标签触发 GitHub 桌面发版 CI
git tag v1.1.0
git push origin v1.1.0
```

CI：`.github/workflows/release-desktop-public.yml`（也可 `workflow_dispatch`）。

---

## 4. 装包后刷新升级通道

客户端轮询清单（**国内优先 Gitee**）：

1. `https://gitee.com/evovexai/EvoFlow/raw/main/update/latest.json`
2. `https://cdn.jsdelivr.net/gh/EvovexAI/EvoFlow@main/update/latest.json`
3. `https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

GitHub Release 上传完成后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/maintainer/windows/push-public-latest-json.ps1 -Tag v1.2.4
```

会写入真实 `hash` / `size`，`url` 默认用 `ghfast` 镜像 GitHub 安装包，并推到 **GitHub + Gitee** 的 `update/latest.json`。

也可 `republish-public-release.ps1 -UpdateLatestJson`。

草稿在 `scripts/maintainer/update/latest.json`；**不要**在安装包未就绪时往公仓根目录塞假的 `update/`。

一键应用内更新还需要 CI secrets `TAURI_SIGNING_PRIVATE_KEY`（+ 可选 password），否则只有「下载安装包」通道，清单无 `platforms`。

---

## 5. 发版前自检（避免再打成旧版）

- [ ] `evopanel/VERSION` == 目标版本（不是只改了 package.json）
- [ ] 跑过 `npm run version:set -- x.y.z`（或确认 sync 后各处一致）
- [ ] `CHANGELOG.md` 有本版完整条目
- [ ] 存在 `PRODUCT-NOTES-x.y.z.md`（否则 Release 正文几乎只有页脚）
- [ ] `latest.json` 的 `version` / `url` / `changelog` 都是本版
- [ ] 已推送提交；将打的 `vX.Y.Z` tag 指向含上述文件的 commit
- [ ] GitHub Latest Release 版本号与安装包文件名一致
- [ ] 装包后已跑 `push-public-latest-json.ps1`（Gitee 清单也能查到新版本）

---

## 相关入口

| 文档 | 内容 |
|------|------|
| 本文 `RELEASE.md` | **升版要改什么（清单）** |
| [`scripts/maintainer/README.md`](scripts/maintainer/README.md) | 维护者脚本索引 |
| [`scripts/maintainer/windows/README.md`](scripts/maintainer/windows/README.md) | 本地一键发 Windows 包 |
| [`scripts/maintainer/update/README.md`](scripts/maintainer/update/README.md) | 升级通道草稿与客户端轮询 |
| [`MAINTAINERS.md`](MAINTAINERS.md) | 谁负责发版 |
| [`.github/workflows/release-desktop-public.yml`](.github/workflows/release-desktop-public.yml) | 桌面 CI 入口 |
