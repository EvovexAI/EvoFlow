# Client update manifest (maintainer draft)

升版本总清单见仓库根 [RELEASE.md](../../../RELEASE.md)。本目录只放升级通道草稿。

## 客户端怎么拉

按顺序尝试（国内优先 Gitee）：

1. `https://gitee.com/evovexai/EvoFlow/raw/main/update/latest.json`
2. `https://cdn.jsdelivr.net/gh/EvovexAI/EvoFlow@main/update/latest.json`
3. `https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

安装包链接：清单里 `url` / `urlGitee` 指向 **Gitee Releases**，`urlGithub` 为海外回退。

## 维护者怎么推

本地草稿：`scripts/maintainer/update/latest.json`（本目录）。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/maintainer/windows/push-public-latest-json.ps1 -Tag v1.2.3
```

会：

1. 写好 hash / size / changelog（UTF-8）
2. 推 **Gitee** `update/latest.json`（`GITEE_REPO_TOKEN` 或本机 `git push gitee` 凭据）
3. 推 **GitHub** `update/latest.json`（Contents API；供 jsDelivr / 海外）

只推国内：

```powershell
... -Tag v1.2.3 -SkipGithub
```

**Windows CI**（`release-windows-public.yml`）发完安装包后也会跑该脚本。

## 注意

- 安装包也要上传到 **Gitee Releases** 同名 tag（`EvoFlow_x.y.z_x64-setup.exe`），否则国内用户点「下载安装包」会 404。可用 `republish-public-release.ps1`（设 `GITEE_REPO_TOKEN`）或手动上传。
- 一键应用内更新还需要签名 `*.nsis.zip` + `TAURI_SIGNING_*`；没有时客户端会退化为「下载安装包」。
- 根目录 `/update/` 在工作区 gitignore；live 文件靠 Contents API / 独立 gitee 提交写入，不要在安装包未就绪时塞假数据。
