# Gitee（现行：只做清单与代码镜像）

## 现在怎么用

和 GitHub 发版的关系见仓库根 [RELEASE.md](../../../RELEASE.md)。

| 用途 | 现状 |
|------|------|
| 代码镜像 | 可 `git push gitee` |
| **检查更新** | 客户端 **优先**读 `https://gitee.com/evovexai/EvoFlow/raw/main/update/latest.json` |
| 正式安装包 | **不在这里**；GitHub Actions 打包并挂 GitHub Releases |
| 国内下载包 | 清单里用 `ghfast` 镜像 GitHub 地址 |

发版后刷新清单（含推 Gitee）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/maintainer/windows/push-public-latest-json.ps1 -Tag v1.2.4
```

## 为什么安装包不放 Gitee

Gitee Release 附件上限约 **100MB**，桌面 `setup.exe` ~380MB，API 会直接拒。  
所以「Gitee 自己挂正式包给人下」走不通；不是流程故意拆两套。

## 可选（当前未启用）

若以后有对象存储公网 URL + 自建 Windows 构建机，才可以再开 Gitee Go 独立打包。  
流水线草稿：`.workflow/release-windows.yml`、`.workflow/smoke.yml`。  
**在没有对象存储之前，不要开这条线**；继续用 GitHub 打包 + Gitee 只托管清单。
