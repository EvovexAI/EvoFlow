# Git 提交步骤

本文档介绍 Git 代码提交流程，适用于首次配置仓库或日常开发提交。

## 1. 配置提交人信息

```bash
# 查看当前配置
git config user.name
git config user.email

# 设置当前仓库的局部配置
git config user.name "Your Name"
git config user.email "your@email.com"
```

> **注意**：以上命令仅修改当前仓库的局部配置。如需修改全局配置，添加 `--global` 参数。

## 2. 查看代码状态

```bash
git status
```

输出说明：
- `modified:` — 已修改的文件
- `Untracked files:` — 未跟踪的新文件
- `deleted:` — 已删除的文件

## 3. 添加文件到暂存区

```bash
# 添加所有修改和新文件
git add .

# 仅添加已修改的文件（不包括新文件）
git add -u

# 添加指定文件
git add <filename>
```

## 4. 提交代码

```bash
git commit -m "type: brief description"
```

提交信息格式建议遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 bug |
| `docs` | 文档变更 |
| `refactor` | 重构代码 |
| `test` | 测试相关 |
| `chore` | 构建/工具变更 |

## 5. 推送到远程仓库

```bash
# 推送到当前分支对应的远程分支
git push

# 首次推送并建立追踪
git push -u origin <branch-name>
```

## 6. 验证提交

```bash
# 查看最近一次提交的详细信息
git log -1 --pretty=format:"Author: %an <%ae>%nDate: %ad%nMessage: %s"

# 查看完整提交历史
git log --oneline
```

## 常用命令速查

| 命令 | 说明 |
|------|------|
| `git status` | 查看当前代码状态 |
| `git add .` | 添加所有文件到暂存区 |
| `git commit -m "msg"` | 提交代码 |
| `git push` | 推送到远程仓库 |
| `git log --oneline` | 查看提交历史（简洁） |
| `git diff` | 查看文件修改内容 |

---

**最后验证**：2026-05-10；适用范围：默认分支。
