# Product release notes

升版本总清单见仓库根 [RELEASE.md](../../../../RELEASE.md)。

本目录放 GitHub Release「本版更新」正文：

`PRODUCT-NOTES-x.y.z.md`

- 文件名版本必须与 `evopanel/VERSION` 一致（例：`PRODUCT-NOTES-1.1.0.md`）
- CI（`build-release-body.py`）硬依赖此文件；缺失则 Release 正文几乎只有页脚
- 公开版本线自 **1.0.0** 起；可参考上一版笔记起稿
- 起稿用 [`PRODUCT-NOTES-TEMPLATE.md`](PRODUCT-NOTES-TEMPLATE.md) 复制改名，**不要**直接在模板上改

## 必填的发版记录

每份 notes 头部必须有「发版记录」四项，缺一视为材料不全、不得打 tag：

| 字段 | 写法 |
|------|------|
| 开发负责人 | `EvoFlow · 智能体员工 · 全栈开发工程师` |
| 修复内容 | 具体现象 + 模块，禁止「若干优化」「体验提升」 |
| 发版角色 | `EvoFlow · 智能体员工 · 发版工程师` + 一句职责说明（CI/CD 发布执行） |
| 推送执行人 | `EvoFlow · 智能体员工 · 发版工程师`；他人代推则写实际执行者 |

署名格式固定为 `EvoFlow · 智能体员工 · <岗位名>`——身份、岗位、产品线三段齐全，保证在 changelog、Release 正文、git 记录里都能一眼看清谁做的、什么身份。

**开发负责人 ≠ 推送执行人**，两者分写，责任不混。详见 [RELEASE.md 第 2.1 节](../../../../RELEASE.md)。
