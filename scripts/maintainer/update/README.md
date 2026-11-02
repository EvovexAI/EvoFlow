# Client update manifest (maintainer draft)

升版本总清单见仓库根 [RELEASE.md](../../../RELEASE.md)。本目录只放升级通道草稿。

## 现行路径

| 东西 | 放哪 | 谁做 |
|------|------|------|
| `setup.exe` / DMG | **GitHub Releases** | 打 `v*` tag → GitHub Actions 自打包 |
| `update/latest.json` | **Gitee + GitHub**（同一内容） | `push-public-latest-json.ps1` / CI |
| 国内「有没有更新」 | 先读 Gitee 上的清单 | 客户端写死优先顺序 |
| 国内「下载安装包」 | `ghfast.top` 镜像 GitHub Release URL | 写进清单的 `url` / `urlCnMirror` |

Gitee Releases **挂不下** ~380MB 安装包（附件约 100MB 上限）。不要把 GitHub 打好的包再上传到 Gitee。

## 客户端怎么拉清单（国内优先）

1. `https://gitee.com/evovexai/EvoFlow/raw/main/update/latest.json` ← **优先**
2. `https://cdn.jsdelivr.net/gh/EvovexAI/EvoFlow@main/update/latest.json`
3. `https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

## 维护者怎么推清单

GitHub Release 上传完成后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/maintainer/windows/push-public-latest-json.ps1 -Tag v1.2.4
```

默认：`InstallerHost=github`，`url` = ghfast 镜像；同时推 GitHub 与 Gitee 上的 `update/latest.json`。
