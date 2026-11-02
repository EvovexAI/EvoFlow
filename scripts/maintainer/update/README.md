# Client update manifest (maintainer draft)

升版本总清单见仓库根 [RELEASE.md](../../../RELEASE.md)。本目录只放升级通道草稿。

## 分工（别再手工搬安装包）

| 东西 | 放哪 | 谁做 |
|------|------|------|
| `setup.exe` / DMG | **GitHub Releases** | CI 打 `v*` tag 后自动打包上传 |
| `update/latest.json` | **Gitee**（国内优先）+ GitHub/jsDelivr | `push-public-latest-json.ps1` / CI |
| 国内下载 `setup.exe` | `https://ghfast.top/` + GitHub Release URL | 写进清单的 `url` / `urlCnMirror` |

Gitee `attach_files` 硬限制约 **100MB**，不能托管桌面安装包。不要再「从 GitHub 下下来再传到 Gitee」。

## 客户端怎么拉清单

1. `https://gitee.com/evovexai/EvoFlow/raw/main/update/latest.json`
2. `https://cdn.jsdelivr.net/gh/EvovexAI/EvoFlow@main/update/latest.json`
3. `https://raw.githubusercontent.com/EvovexAI/EvoFlow/main/update/latest.json`

## 维护者怎么推清单

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/maintainer/windows/push-public-latest-json.ps1 -Tag v1.2.4
```

只推国内：加 `-SkipGithub`。  
**Windows CI** 发完安装包后也会跑该脚本。
