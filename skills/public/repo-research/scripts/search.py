#!/usr/bin/env python3
"""
repo-research 语义搜索模块

提供类似 Zread search_doc 的能力，支持多种模式搜索代码仓库。
"""

import argparse
import os
import subprocess
import json
import re
from pathlib import Path
from typing import List, Dict, Optional


class CodeSearcher:
    """代码语义搜索器"""

    # 搜索模式定义
    SEARCH_PATTERNS = {
        # Python
        "py": {
            "function": r"def\s+(\w+)\s*\(",
            "class": r"class\s+(\w+)[\(:]",
            "import": r"^(?:from\s+[\w.]+\s+)?import\s+[\w.]+",
            "doc": r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'',
            "async": r"async\s+def\s+",
        },
        # JavaScript/TypeScript
        "js": {
            "function": r"(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?\(|(\w+)\s*:\s*(?:async\s+)?\()",
            "class": r"class\s+(\w+)",
            "import": r'(?:import\s+.*?from\s+[\'"][^\'"]+[\'"]|require\s*\([\'"][^\'"]+[\'"]\))',
            "doc": r"(?:/\*\*[\s\S]*?\*/|//\s*.*)",
            "export": r"export\s+(?:default\s+)?(?:function|class|const|let|var)",
        },
        "ts": {
            "function": r"(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?\(|(\w+)\s*\([^)]*\)\s*:)",
            "class": r"class\s+(\w+)",
            "import": r'(?:import\s+.*?from\s+[\'"][^\'"]+[\'"]|import\s+[\'"][^\'"]+)',
            "doc": r"(?:/\*\*[\s\S]*?\*/)",
            "interface": r"interface\s+(\w+)",
            "type": r"type\s+(\w+)",
        },
        # Go
        "go": {
            "function": r"func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(",
            "struct": r"type\s+(\w+)\s+struct",
            "import": r'import\s+[\("(]',
            "interface": r"type\s+(\w+)\s+interface",
            "package": r"^package\s+\w+",
        },
        # Rust
        "rs": {
            "function": r"fn\s+(\w+)\s*\(",
            "struct": r"struct\s+(\w+)",
            "impl": r"impl(?:\s+<\w+>)?\s+(?:\w+\s+for\s+)?(\w+)",
            "use": r"use\s+\w+::",
            "mod": r"^mod\s+\w+",
        },
        # Java
        "java": {
            "function": r"(?:public|private|protected)\s+(?:static\s+)?[\w<>]+\s+(\w+)\s*\(",
            "class": r"class\s+(\w+)",
            "import": r"import\s+[\w.]+;",
            "interface": r"interface\s+(\w+)",
            "package": r"^package\s+[\w.]+;",
        },
    }

    def __init__(self, repo_path: str):
        """初始化搜索器

        Args:
            repo_path: 仓库本地路径
        """
        self.repo_path = Path(repo_path)
        if not self.repo_path.exists():
            raise ValueError(f"仓库路径不存在: {repo_path}")

    def get_file_type(self, file_path: str) -> Optional[str]:
        """根据文件扩展名获取文件类型"""
        ext = Path(file_path).suffix.lstrip(".")
        type_map = {
            "py": "py",
            "js": "js",
            "jsx": "js",
            "ts": "ts",
            "tsx": "ts",
            "go": "go",
            "rs": "rs",
            "java": "java",
        }
        return type_map.get(ext)

    def search(
        self, pattern: str, mode: str = "pattern", max_results: int = 50
    ) -> List[Dict]:
        """执行搜索

        Args:
            pattern: 搜索模式或关键词
            mode: 搜索模式 (function/class/import/doc/pattern)
            max_results: 最大返回结果数

        Returns:
            搜索结果列表
        """
        results = []

        # 获取仓库中的代码文件
        code_extensions = {".py", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".java"}
        code_files = []

        for ext in code_extensions:
            code_files.extend(self.repo_path.rglob(f"*{ext}"))

        # 排除 node_modules, __pycache__, .git 等
        exclude_dirs = {
            "node_modules",
            "__pycache__",
            ".git",
            "venv",
            ".venv",
            "dist",
            "build",
            "target",
        }

        code_files = [
            f for f in code_files if not any(exc in f.parts for exc in exclude_dirs)
        ]

        if mode == "pattern":
            # 普通模式搜索 - 使用 grep
            results = self._grep_search(pattern, code_files, max_results)
        else:
            # 语义模式搜索
            results = self._semantic_search(pattern, mode, code_files, max_results)

        return results

    def _grep_search(
        self, pattern: str, files: List[Path], max_results: int
    ) -> List[Dict]:
        """使用 grep 进行模式搜索"""
        results = []

        for file_path in files[:100]:  # 限制文件数量
            try:
                # 使用 ripgrep 或 grep
                cmd = [
                    "rg",
                    "-n",
                    "--no-heading",
                    "-e",
                    pattern,
                    str(file_path),
                    "--json",
                ]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)

                if result.returncode == 0:
                    for line in result.stdout.strip().split("\n"):
                        if line:
                            try:
                                data = json.loads(line)
                                if "data" in data:
                                    match = data["data"]
                                    results.append(
                                        {
                                            "file": str(
                                                match.get("path", {}).get(
                                                    "text", file_path
                                                )
                                            ),
                                            "line": match.get("line_number", 0),
                                            "content": match.get("lines", {})
                                            .get("text", "")
                                            .strip(),
                                        }
                                    )
                            except json.JSONDecodeError:
                                pass
            except Exception as e:
                # 如果 rg 不可用，尝试使用 grep
                try:
                    cmd = ["grep", "-rn", pattern, str(file_path)]
                    result = subprocess.run(
                        cmd, capture_output=True, text=True, timeout=10
                    )
                    if result.returncode == 0:
                        for line in result.stdout.strip().split("\n"):
                            if ":" in line:
                                parts = line.split(":", 2)
                                if len(parts) >= 3:
                                    results.append(
                                        {
                                            "file": parts[0],
                                            "line": parts[1],
                                            "content": parts[2].strip(),
                                        }
                                    )
                except Exception:
                    pass

            if len(results) >= max_results:
                break

        return results[:max_results]

    def _semantic_search(
        self, pattern: str, mode: str, files: List[Path], max_results: int
    ) -> List[Dict]:
        """语义搜索 - 根据模式类型搜索"""
        results = []

        for file_path in files:
            file_type = self.get_file_type(str(file_path))
            if not file_type:
                continue

            patterns = self.SEARCH_PATTERNS.get(file_type, {})
            regex_pattern = patterns.get(mode, patterns.get("function"))

            if not regex_pattern:
                continue

            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                    matches = re.finditer(regex_pattern, content, re.MULTILINE)

                    for match in matches:
                        line_num = content[: match.start()].count("\n") + 1
                        line_start = content.rfind("\n", 0, match.start()) + 1
                        line_end = content.find("\n", match.start())
                        if line_end == -1:
                            line_end = len(content)
                        line_content = content[line_start:line_end].strip()

                        results.append(
                            {
                                "file": str(file_path),
                                "line": line_num,
                                "mode": mode,
                                "match": match.group(0),
                                "content": line_content,
                            }
                        )

                        if len(results) >= max_results:
                            break
            except Exception:
                pass

            if len(results) >= max_results:
                break

        return results[:max_results]

    def search_function(self, name_pattern: str) -> List[Dict]:
        """搜索函数定义"""
        return self.search(name_pattern, mode="function")

    def search_class(self, name_pattern: str) -> List[Dict]:
        """搜索类定义"""
        return self.search(name_pattern, mode="class")

    def search_imports(self, pattern: str = "") -> List[Dict]:
        """搜索导入语句"""
        return self.search(pattern, mode="import")


def format_results(results: List[Dict]) -> str:
    """格式化搜索结果"""
    if not results:
        return "未找到匹配结果"

    output = []
    current_file = None

    for i, result in enumerate(results):
        file_path = result.get("file", "")

        if file_path != current_file:
            output.append(f"\n## {file_path}\n")
            current_file = file_path

        line = result.get("line", "")
        content = result.get("content", "")

        output.append(f"- **{line}**: {content[:100]}")

    return "\n".join(output)


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description="repo-research 语义搜索工具")
    parser.add_argument("repo_path", help="仓库本地路径")
    parser.add_argument("pattern", help="搜索模式或关键词")
    parser.add_argument(
        "--mode",
        "-m",
        default="pattern",
        choices=["pattern", "function", "class", "import", "doc"],
        help="搜索模式",
    )
    parser.add_argument("--max", "-n", type=int, default=50, help="最大结果数")
    parser.add_argument("--json", "-j", action="store_true", help="JSON 格式输出")

    args = parser.parse_args()

    try:
        searcher = CodeSearcher(args.repo_path)
        results = searcher.search(args.pattern, args.mode, args.max)

        if args.json:
            print(json.dumps(results, ensure_ascii=False, indent=2))
        else:
            print(format_results(results))

    except Exception as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    import sys

    main()
