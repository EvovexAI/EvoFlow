#!/usr/bin/env python3
"""
代码质量分析器 - 分析代码质量指标和潜在问题
"""

import re
from pathlib import Path
from typing import Dict, List, Set
from collections import defaultdict


class QualityAnalyzer:
    """代码质量分析器"""

    def __init__(self, repo_path: str):
        """初始化分析器

        Args:
            repo_path: 仓库本地路径
        """
        self.repo_path = Path(repo_path)
        if not self.repo_path.exists():
            raise ValueError(f"仓库路径不存在: {repo_path}")

    def analyze(self) -> Dict:
        """执行完整代码质量分析

        Returns:
            质量分析结果
        """
        return {
            "code_stats": self._collect_code_stats(),
            "comments": self._analyze_comments(),
            "tech_debt": self._find_tech_debt(),
            "issues": self._detect_issues(),
        }

    def _collect_code_stats(self) -> Dict:
        """收集代码统计"""
        stats = {
            "total_lines": 0,
            "code_lines": 0,
            "comment_lines": 0,
            "blank_lines": 0,
            "by_language": defaultdict(lambda: {"files": 0, "lines": 0}),
        }

        exclude_dirs = {
            ".git",
            "node_modules",
            "__pycache__",
            "venv",
            ".venv",
            "dist",
            "build",
            "target",
        }

        for file_path in self.repo_path.rglob("*"):
            if not file_path.is_file():
                continue

            if any(exc in file_path.parts for exc in exclude_dirs):
                continue

            ext = file_path.suffix.lstrip(".")
            if not ext:
                continue

            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    lines = f.readlines()
                    total = len(lines)
                    blank = sum(1 for line in lines if not line.strip())
                    comment = 0

                    # 简单注释统计
                    for line in lines:
                        stripped = line.strip()
                        if stripped.startswith("#") or stripped.startswith("//"):
                            comment += 1
                        elif stripped.startswith("/*") or stripped.startswith("*"):
                            comment += 1

                    code = total - blank

                    stats["total_lines"] += total
                    stats["code_lines"] += code
                    stats["comment_lines"] += comment
                    stats["blank_lines"] += blank
                    stats["by_language"][ext]["files"] += 1
                    stats["by_language"][ext]["lines"] += code

            except Exception:
                pass

        # 转换为普通字典
        stats["by_language"] = dict(stats["by_language"])
        return stats

    def _analyze_comments(self) -> Dict:
        """分析注释情况"""
        comment_stats = {
            "total": 0,
            "doc_comments": 0,
            "line_comments": 0,
            "file_coverage": {},  # 文件 -> 是否有文档注释
        }

        exclude_dirs = {".git", "node_modules", "__pycache__", "venv", ".venv"}

        doc_patterns = {
            "py": r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'',
            "js": r"/\*\*[\s\S]*?\*/",
            "ts": r"/\*\*[\s\S]*?\*/",
            "java": r"/\*\*[\s\S]*?\*/",
            "go": r"//.*",
        }

        for file_path in self.repo_path.rglob("*"):
            if not file_path.is_file():
                continue

            if any(exc in file_path.parts for exc in exclude_dirs):
                continue

            ext = file_path.suffix.lstrip(".")

            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                    lines = content.split("\n")

                    line_comments = sum(
                        1 for line in lines if line.strip().startswith(("#", "//"))
                    )
                    doc_comments = 0

                    if ext in doc_patterns:
                        doc_comments = len(re.findall(doc_patterns[ext], content))

                    comment_stats["total"] += line_comments + doc_comments
                    comment_stats["line_comments"] += line_comments
                    comment_stats["doc_comments"] += doc_comments

                    rel_path = str(file_path.relative_to(self.repo_path))
                    comment_stats["file_coverage"][rel_path] = {
                        "has_docs": doc_comments > 0,
                        "comments": line_comments + doc_comments,
                    }

            except Exception:
                pass

        return comment_stats

    def _find_tech_debt(self) -> Dict:
        """查找技术债务"""
        debt = {
            "todos": [],
            "fixmes": [],
            "deprecated": [],
            "hacks": [],
        }

        patterns = {
            "todo": r"#?\s*TODO[:\s]",
            "fixme": r"#?\s*FIXME[:\s]",
            "deprecated": r"@deprecated|deprecated",
            "hack": r"#?\s*HACK[:\s]",
        }

        exclude_dirs = {".git", "node_modules", "__pycache__", "venv", ".venv"}

        for file_path in self.repo_path.rglob("*"):
            if not file_path.is_file():
                continue

            if any(exc in file_path.parts for exc in exclude_dirs):
                continue

            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    for i, line in enumerate(f, 1):
                        for debt_type, pattern in patterns.items():
                            if re.search(pattern, line, re.IGNORECASE):
                                rel_path = str(file_path.relative_to(self.repo_path))
                                debt[debt_type].append(
                                    {
                                        "file": rel_path,
                                        "line": i,
                                        "content": line.strip()[:100],
                                    }
                                )

            except Exception:
                pass

        return debt

    def _detect_issues(self) -> Dict:
        """检测潜在问题"""
        issues = {
            "hardcoded_secrets": [],
            "console_logs": [],
            "empty_files": [],
            "large_files": [],
        }

        exclude_dirs = {".git", "node_modules", "__pycache__", "venv", ".venv"}

        secret_patterns = [
            r'password\s*=\s*["\'][^"\']+["\']',
            r'api_key\s*=\s*["\'][^"\']+["\']',
            r'secret\s*=\s*["\'][^"\']+["\']',
            r'token\s*=\s*["\'][^"\']+["\']',
            r"AKIA[0-9A-Z]{16}",  # AWS Access Key
        ]

        for file_path in self.repo_path.rglob("*"):
            if not file_path.is_file():
                continue

            if any(exc in file_path.parts for exc in exclude_dirs):
                continue

            # 检查文件大小
            try:
                size = file_path.stat().st_size
                if size > 100_000:  # > 100KB
                    rel_path = str(file_path.relative_to(self.repo_path))
                    issues["large_files"].append(
                        {
                            "file": rel_path,
                            "size_kb": round(size / 1024, 1),
                        }
                    )
            except Exception:
                pass

            # 检查文件是否为空
            try:
                if file_path.stat().st_size == 0:
                    rel_path = str(file_path.relative_to(self.repo_path))
                    issues["empty_files"].append(rel_path)
            except Exception:
                pass

            # 检查敏感信息和日志
            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()

                    # 检查硬编码密钥
                    for pattern in secret_patterns:
                        matches = re.finditer(pattern, content, re.IGNORECASE)
                        for match in matches:
                            rel_path = str(file_path.relative_to(self.repo_path))
                            issues["hardcoded_secrets"].append(
                                {
                                    "file": rel_path,
                                    "type": "potential_secret",
                                }
                            )
                            break

                    # 检查 console.log
                    if "console.log" in content or "console.error" in content:
                        rel_path = str(file_path.relative_to(self.repo_path))
                        count = content.count("console.log") + content.count(
                            "console.error"
                        )
                        issues["console_logs"].append(
                            {
                                "file": rel_path,
                                "count": count,
                            }
                        )

            except Exception:
                pass

        return issues

    def generate_report(self) -> str:
        """生成质量分析报告"""
        analysis = self.analyze()
        stats = analysis["code_stats"]

        lines = [
            "# 代码质量分析报告\n",
            f"> 分析目标: {self.repo_path.name}\n",
            "---\n",
            "\n## 代码统计",
            f"- 总行数: {stats['total_lines']:,}",
            f"- 代码行: {stats['code_lines']:,}",
            f"- 注释行: {stats['comment_lines']:,}",
            f"- 空白行: {stats['blank_lines']:,}",
        ]

        # 计算注释率
        if stats["code_lines"] > 0:
            comment_ratio = stats["comment_lines"] / stats["code_lines"] * 100
            lines.append(f"- 注释率: {comment_ratio:.1f}%")

        # 按语言统计
        if stats["by_language"]:
            lines.append("\n### 按语言统计")
            for lang, data in sorted(
                stats["by_language"].items(), key=lambda x: x[1]["lines"], reverse=True
            )[:5]:
                lines.append(
                    f"- **{lang}**: {data['files']} 文件, {data['lines']:,} 行代码"
                )

        # 技术债务
        debt = analysis["tech_debt"]
        if any(debt.values()):
            lines.append("\n## 技术债务")

            if debt["todos"]:
                lines.append(f"\n### TODO ({len(debt['todos'])} 项)")
                for item in debt["todos"][:5]:
                    lines.append(
                        f"- `{item['file']}:{item['line']}` - {item['content']}"
                    )

            if debt["fixmes"]:
                lines.append(f"\n### FIXME ({len(debt['fixmes'])} 项)")
                for item in debt["fixmes"][:5]:
                    lines.append(
                        f"- `{item['file']}:{item['line']}` - {item['content']}"
                    )

        # 问题检测
        issues = analysis["issues"]
        if any(issues.values()):
            lines.append("\n## 问题检测")

            if issues["hardcoded_secrets"]:
                lines.append(
                    f"\n### ⚠️ 硬编码密钥 ({len(issues['hardcoded_secrets'])} 个)"
                )
                for item in issues["hardcoded_secrets"][:3]:
                    lines.append(f"- `{item['file']}` - 检测到可能的密钥")

            if issues["console_logs"]:
                lines.append(
                    f"\n### Console 日志 ({len(issues['console_logs'])} 个文件)"
                )
                for item in issues["console_logs"][:3]:
                    lines.append(f"- `{item['file']}` - {item['count']} 处")

            if issues["large_files"]:
                lines.append(f"\n### 大文件 ({len(issues['large_files'])} 个)")
                for item in issues["large_files"][:3]:
                    lines.append(f"- `{item['file']}` - {item['size_kb']} KB")

        return "\n".join(lines)


def main():
    """测试入口"""
    import sys

    if len(sys.argv) < 2:
        print("用法: python -m analyzer.quality <仓库路径>")
        sys.exit(1)

    repo_path = sys.argv[1]
    analyzer = QualityAnalyzer(repo_path)
    print(analyzer.generate_report())


if __name__ == "__main__":
    main()
