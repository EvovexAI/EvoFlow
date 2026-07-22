# 私有仓与公共仓推送指南

> **仅存在于私有仓库**（`evolvear/haze-ctrl`），不会同步到 [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。

本地开发目录：`d:\github\EvoFlow`（或你 clone 私仓的路径）。**全量代码只推私有仓**；公共仓是**白名单镜像**，两套 Git 历史、两套账号，互不混用。

---

## 1. 两个仓库怎么分工

| | 私有仓 | 公共仓 |
|---|--------|--------|
| **GitHub** | `evolvear/haze-ctrl` | `EvovexAI/EvoFlow` |
| **内容** | 全部源码（backend、evopanel、skills、脚本、`.github` 等） | 仅官网/文档等白名单（见下文） |
| **提交作者** | `evolvear` | `EvovexAI` |
| **怎么推** | 日常 `git push origin` | **只**跑同步脚本，禁止 `git push` 整仓 |

---

## 2. 本地 Git 配置（一次性）

在私仓根目录执行（**只改本仓库**，不要 `git config --global`）：

```powershell
cd d:\github\EvoFlow

git remote set-url origin git@github-private:evolvear/haze-ctrl.git

git config user.name "evolvear"
git config user.email "evolve@evovexai.com"
```

检查：

```powershell
.\scripts\windows\verify-git-remotes.ps1
```

应看到 `origin` 指向 `haze-ctrl`，作者为 `evolvear`。

---

## 3. 推送私有仓（日常开发）

```powershell
cd d:\github\EvoFlow

git status
git add <文件或 .>
git commit -m "feat: 你的说明"

# 若全局 git commit 报 trailer 错误，用：
git -c alias.commit= commit -m "feat: 你的说明"

git push origin main
```

**只推 `origin`**，即 `evolvear/haze-ctrl`。

---

## 4. 推送公共仓（同步镜像）

公共仓**不要** `git push origin` 整项目。用脚本把白名单目录拷贝过去，提交身份为 **EvovexAI**。

### 4.1 首次配置

1. 复制 `scripts/windows/local-publish.env.example` → `scripts/windows/local-publish.env`（已在 `.gitignore`，勿提交）。
2. 填入 **EvovexAI 专用** 凭据（二选一）：
   - **PAT（HTTPS）**：`PUBLIC_REPO_TOKEN` 或 `GITHUB_TOKEN`，权限含 `EvovexAI/EvoFlow` Contents 读写。
   - **Deploy key（SSH）**：`EVOFLOW_PUBLIC_REPO_SSH_KEY` 指向仅用于公共仓的私钥路径。

3. 建议同时设置公共提交显示名：

```env
EVOFLOW_PUBLIC_GIT_USER_NAME=EvovexAI
EVOFLOW_PUBLIC_GIT_USER_EMAIL=evovexai@users.noreply.github.com
```

GitHub 侧 Deploy key / Secrets 详见：[public-repo-github-setup.md](../../user/explanation/public-repo-github-setup.md)（该文件会随 `docs/` 同步到公共仓，不含私仓密钥）。

### 4.2 日常更新公共镜像

改完 `website/`、`docs/`、`README.md` 等对外内容后：

```powershell
cd d:\github\EvoFlow

# 先推私仓
git push origin main

# 再同步公共仓
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\local-publish.ps1 -SyncPublic
```

或双击 / 运行：

```text
scripts\windows\local-publish.bat -SyncPublic
```

公共仓会出现一条新 commit，例如 `chore: update public mirror`，作者为 **EvovexAI**。

### 4.3 会进入公共仓的路径（白名单）

与 `.github/workflows/sync-public.yml` 一致：

```text
website/
docs/
update/
README.md
CLAUDE.md
CONTRIBUTING.md
SECURITY.md
LICENSE
NOTICE
licenses/
mkdocs.yml
requirements-docs.txt
.gitignore
scripts/windows/public-release-body.txt
```

同步时会自动：

- 去掉 `website` 内简历等私密页面（`strip-resume-for-public.mjs`）
- 排除 `node_modules` 等大目录
- **不**带 `.github/`、backend、evopanel、skills 等

**不会**写入 `.sync-from` 或私仓 commit SHA，避免两套历史挂钩。

---

## 5. 特殊场景

### 5.1 首次初始化 / 重写公共历史

公共 `main` 只保留 1 条 commit、作者 EvovexAI，并删除旧 tags/releases：

```powershell
.\scripts\windows\init-public-mirror.bat
```

等价于 `local-publish.ps1 -SyncPublic -FreshPublicHistory`（会先删公共 tags/releases 再 force push）。

### 5.2 只清理公共仓旧 tag / Release

若 Contributors 仍显示旧作者，多半是 **tag 还指着旧 commit**：

```powershell
.\scripts\windows\wipe-public-old-refs.bat
```

### 5.3 桌面端发公共 Release

安装包与 GitHub Release 仍指向公共仓，见：

```text
scripts\windows\README.md
scripts\windows\release-evopanel-public.bat
```

典型顺序：私仓改代码 → 私仓 push →（可选）`-SyncPublic` → `release-evopanel-public` 打 tag/Release。

---

## 6. 脚本速查

| 脚本 | 作用 |
|------|------|
| `verify-git-remotes.ps1` | 检查 `origin` 是否误指公共仓、作者是否正确 |
| `local-publish.ps1 -SyncPublic` | 增量同步白名单到公共 `main` |
| `init-public-mirror.bat` | 公共仓全新单 commit + 清 tags/releases |
| `wipe-public-old-refs.bat` | 仅删公共 tags 与 Releases |
| `local-publish.ps1 -All` | 本地全量发布（构建、TOS、同步、Release，见 README） |

---

## 7. 禁止事项

- 不要用 **evolvear** 账号直接 `git push` 到 `EvovexAI/EvoFlow`
- 不要把 `EvovexAI/EvoFlow` 设为 `origin` 后日常开发
- 不要提交 `scripts/windows/local-publish.env`（含 Token/密钥）
- 不要用 evolvear 的 SSH key 推公共仓（应用 EvovexAI Deploy key 或 PAT）

---

## 8. 推荐工作流（小结）

```text
1. 在 EvoFlow 目录改代码
2. git commit（evolvear）→ git push origin main     → 私有仓
3. 需要更新对外文档/官网时：
   local-publish.ps1 -SyncPublic                   → 公共仓
4. 需要发桌面安装包时：
   release-evopanel-public.bat（见 scripts/windows/README.md）
```

---

## 9. 常见问题

**Q：公共仓 Commits 页只有 1 条，Contributors 还有旧人？**  
A：GitHub 缓存；确认 [Tags](https://github.com/EvovexAI/EvoFlow/tags) 为空后等几天，或跑 `wipe-public-old-refs.bat`。

**Q：`git push origin` 403？**  
A：检查 SSH 是否走 `github-private` 且为 evolvear 密钥。

**Q：`-SyncPublic` 403 / 超时？**  
A：检查 `local-publish.env` 里 `PUBLIC_REPO_TOKEN` 是否对 `EvovexAI/EvoFlow` 有写权限；网络不稳定时可重试。

**Q：私仓和公共仓 commit 能一样吗？**  
A：内容来自白名单拷贝，**commit hash 一定不同**；也不应在公共 commit 里引用私仓 SHA。

---

## 10. 相关文件

| 路径 | 说明 |
|------|------|
| `scripts/windows/local-publish.ps1` | 同步与发布主脚本 |
| `scripts/windows/local-publish.env.example` | 凭据模板 |
| `.github/workflows/release-desktop.yml` | 推送 `v*` 标签：公共仓同步 → Win/macOS 构建发布 |
| `.github/workflows/sync-public.yml` | 被 release-desktop 调用；凭据 **`PUBLIC_REPO_GH_TOKEN`** + 可选 **`GITEE_REPO_TOKEN`** |

**CI 发版 Secrets（私有仓）**

| Secret | 用途 |
|--------|------|
| `PUBLIC_REPO_GH_TOKEN` | 同步公共镜像 `main`（GitHub）、创建/上传 Release、`latest.json` |
| `GITEE_REPO_TOKEN` | 同步白名单到 Gitee；发版时再镜像安装包到 Gitee Releases（非 LFS）；缺则跳过 Gitee |
| `TAURI_SIGNING_PRIVATE_KEY` | Windows 一键更新签名（`.nsis.zip`） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥有密码时必填 |

本地 `-SyncPublic` 仍可用 SSH（`PUBLIC_REPO_SSH_KEY` / `EVOFLOW_PUBLIC_REPO_SSH_KEY`），与 CI 无关。
| `docs/user/explanation/public-repo-github-setup.md` | GitHub / Gitee 公共仓与 Secrets 配置 |
