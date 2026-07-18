# 公共仓库 GitHub 配置清单（EvovexAI/EvoFlow）

在本地执行 `local-publish.ps1 -SyncPublic -FreshPublicHistory` 之前，请在 GitHub 完成以下项。

## 1. Deploy key 或机器用户 SSH（推荐）

1. 生成**仅用于公共仓**的密钥（勿与 evolvear 个人密钥混用）：
   ```powershell
   ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_ed25519_evovex_public -C "evovex-public-mirror"
   ```
2. 打开 **EvovexAI/EvoFlow → Settings → Deploy keys → Add deploy key**
3. 粘贴 `id_ed25519_evovex_public.pub`，勾选 **Allow write access**
4. 在 `scripts/windows/local-publish.env` 设置：
   ```env
   EVOFLOW_PUBLIC_GIT_URL=git@github.com:EvovexAI/EvoFlow.git
   EVOFLOW_PUBLIC_REPO_SSH_KEY=C:/Users/你的用户名/.ssh/id_ed25519_evovex_public
   EVOFLOW_PUBLIC_GIT_USER_NAME=EvovexAI
   EVOFLOW_PUBLIC_GIT_USER_EMAIL=evovexai@users.noreply.github.com
   ```

或将私钥 **base64 单行** 写入 `PUBLIC_REPO_SSH_KEY=`（脚本会自动解码到临时文件）。

## 2. 或使用 Fine-grained / Classic PAT（HTTPS）

1. Token 权限：`EvovexAI/EvoFlow` 的 **Contents: Read and write**
2. `local-publish.env`：
   ```env
   PUBLIC_REPO_TOKEN=ghp_xxxx
   # 默认已使用 https://github.com/EvovexAI/EvoFlow.git，无需 SSH
   EVOFLOW_PUBLIC_GIT_USER_NAME=EvovexAI
   EVOFLOW_PUBLIC_GIT_USER_EMAIL=evovexai@users.noreply.github.com
   ```

## 3. CI 同步（可选）

仓库 **Settings → Secrets → Actions**：

| Secret | 说明 |
|--------|------|
| `PUBLIC_REPO_GH_TOKEN` | GitHub PAT：对 `EvovexAI/EvoFlow` Contents（及发版时 Releases）写权限 |
| `GITEE_REPO_TOKEN` | Gitee 私人令牌：对 [evovexai/EvoFlow](https://gitee.com/evovexai/EvoFlow) 仓库写权限；缺则只同步 GitHub |
| `EVOFLOW_PUBLIC_GIT_USER_NAME` | 可选，默认 `EvovexAI` |
| `EVOFLOW_PUBLIC_GIT_USER_EMAIL` | 可选 |

手动运行 **Actions → Sync to Public Repository**（会推 GitHub；配了 `GITEE_REPO_TOKEN` 时再推 Gitee）。

### 3.1 Gitee 私人令牌

1. [Gitee 私人令牌](https://gitee.com/profile/personal_access_tokens) → 新建，勾选 **projects**（仓库读写）
2. 私有仓 Secrets 增加 `GITEE_REPO_TOKEN` = 该令牌
3. 目标仓：[gitee.com/evovexai/EvoFlow](https://gitee.com/evovexai/EvoFlow)（可空仓；首次同步会 init 后 push `main`）

## 4. 初始化公共提交历史（本地）

```powershell
cd d:\github\EvoFlow
.\scripts\windows\verify-git-remotes.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\local-publish.ps1 -SyncPublic -FreshPublicHistory
```

成功后公共仓 `main` 仅 **1 条** commit，作者为 EvovexAI，无 `.sync-from`、无私仓 SHA。

## 5. 安全提醒

- `local-publish.env` 已在 `.gitignore`，**勿提交**
- Deploy key / PAT 只给 **EvovexAI/EvoFlow**，不要授予组织内其他仓库写权限（按需最小权限）
