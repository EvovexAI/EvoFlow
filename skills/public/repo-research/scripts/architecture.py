#!/usr/bin/env python3
"""
架构分析器 - 分析仓库的架构特征和模块关系
"""

import os
import json
from pathlib import Path
from typing import Dict, List, Set, Optional
from collections import defaultdict


class ArchitectureAnalyzer:
    """仓库架构分析器"""

    def __init__(self, repo_path: str):
        """初始化分析器

        Args:
            repo_path: 仓库本地路径
        """
        self.repo_path = Path(repo_path)
        if not self.repo_path.exists():
            raise ValueError(f"仓库路径不存在: {repo_path}")

    def analyze(self) -> Dict:
        """执行完整架构分析

        Returns:
            架构分析结果
        """
        return {
            "directory_structure": self._analyze_directory_structure(),
            "entry_points": self._find_entry_points(),
            "modules": self._identify_modules(),
            "config_files": self._find_config_files(),
            "patterns": self._detect_patterns(),
        }

    def _analyze_directory_structure(self) -> Dict:
        """分析目录结构"""
        structure = {
            "root": [],
            "depth": 0,
            "total_dirs": 0,
            "total_files": 0,
        }

        max_depth = 0
        root_items = []
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

        for item in self.repo_path.iterdir():
            if item.name in exclude_dirs:
                continue

            if item.is_dir():
                structure["total_dirs"] += 1
                depth = self._get_depth(item)
                max_depth = max(max_depth, depth)
            else:
                structure["total_files"] += 1

            root_items.append(
                {
                    "name": item.name,
                    "type": "dir" if item.is_dir() else "file",
                }
            )

        structure["root"] = root_items
        structure["depth"] = max_depth

        return structure

    def _get_depth(self, path: Path) -> int:
        """获取目录深度"""
        try:
            relative = path.relative_to(self.repo_path)
            return len(relative.parts)
        except ValueError:
            return 0

    def _find_entry_points(self) -> List[Dict]:
        """查找入口文件"""
        entry_points = []
        entry_patterns = {
            "package.json": "Node.js 应用入口",
            "pyproject.toml": "Python 项目配置",
            "requirements.txt": "Python 依赖文件",
            "setup.py": "Python 安装脚本",
            "main.py": "Python 主入口",
            "app.py": "Python 应用入口",
            "index.js": "Node.js 入口",
            "main.go": "Go 主入口",
            "main.rs": "Rust 主入口",
            "lib.rs": "Rust 库入口",
            "Cargo.toml": "Rust 项目配置",
            "go.mod": "Go 模块配置",
            "pom.xml": "Java Maven 项目",
            "build.gradle": "Java Gradle 项目",
            "index.html": "Web 应用入口",
            "next.config.js": "Next.js 配置",
            "vite.config.js": "Vite 配置",
        }

        for pattern, description in entry_patterns.items():
            matches = list(self.repo_path.rglob(pattern))
            for match in matches:
                # 排除 node_modules 等
                if any(
                    exc in match.parts
                    for exc in ["node_modules", "__pycache__", ".git"]
                ):
                    continue

                entry_points.append(
                    {
                        "file": str(match.relative_to(self.repo_path)),
                        "type": description,
                    }
                )

        return entry_points

    def _identify_modules(self) -> List[Dict]:
        """识别模块/包结构"""
        modules = []
        exclude_dirs = {
            ".git",
            "node_modules",
            "__pycache__",
            "venv",
            ".venv",
            "dist",
            "build",
        }

        # Python 模块
        for init_file in self.repo_path.rglob("__init__.py"):
            if any(exc in init_file.parts for exc in exclude_dirs):
                continue

            module_path = init_file.parent.relative_to(self.repo_path)
            modules.append(
                {
                    "name": str(module_path),
                    "type": "python_package",
                    "file": str(module_path / "__init__.py"),
                }
            )

        # JavaScript/TypeScript 模块
        for pkg_dir in self.repo_path.rglob("node_modules"):
            continue  # 跳过 node_modules

        # 查找 src 目录
        for src_dir in self.repo_path.rglob("src"):
            if any(exc in src_dir.parts for exc in exclude_dirs):
                continue

            modules.append(
                {
                    "name": str(src_dir.relative_to(self.repo_path)),
                    "type": "source_directory",
                }
            )

        # 查找 lib 目录
        for lib_dir in self.repo_path.rglob("lib"):
            if any(exc in lib_dir.parts for exc in exclude_dirs):
                continue

            modules.append(
                {
                    "name": str(lib_dir.relative_to(self.repo_path)),
                    "type": "library_directory",
                }
            )

        return modules

    def _find_config_files(self) -> List[Dict]:
        """查找配置文件"""
        config_files = []
        config_patterns = [
            ".eslintrc",
            ".eslintrc.js",
            ".eslintrc.json",
            ".eslintrc.yaml",
            ".prettierrc",
            ".prettierrc.js",
            ".prettierrc.json",
            "tsconfig.json",
            "jsconfig.json",
            ".github",  # GitHub Actions 配置目录
            "docker-compose.yml",
            "Dockerfile",
            ".env.example",
            ".env.sample",
        ]

        for pattern in config_patterns:
            if "*" in pattern:
                continue

            matches = list(self.repo_path.rglob(pattern))
            for match in matches:
                if any(exc in match.parts for exc in ["node_modules", ".git"]):
                    continue

                config_files.append(
                    {
                        "file": str(match.relative_to(self.repo_path)),
                        "type": self._classify_config(match.name),
                    }
                )

        return config_files

    def _classify_config(self, filename: str) -> str:
        """分类配置文件类型"""
        if "eslint" in filename.lower():
            return "代码规范"
        elif "prettier" in filename.lower():
            return "代码格式化"
        elif "tsconfig" in filename.lower() or "jsconfig" in filename.lower():
            return "TypeScript/JavaScript 配置"
        elif "github" in filename.lower():
            return "CI/CD 配置"
        elif "docker" in filename.lower():
            return "容器配置"
        elif ".env" in filename.lower():
            return "环境配置"
        else:
            return "其他配置"

    def _detect_patterns(self) -> List[Dict]:
        """检测架构模式"""
        patterns = []

        # 检测 MVC 模式
        mvc_indicators = ["controllers", "models", "views", "routes"]
        if any(
            ind in str(p) for p in self.repo_path.rglob("*") for ind in mvc_indicators
        ):
            patterns.append(
                {
                    "name": "MVC 架构",
                    "confidence": "medium",
                }
            )

        # 检测微服务模式
        if any((self.repo_path / d).exists() for d in ["services", "microservices"]):
            patterns.append(
                {
                    "name": "微服务架构",
                    "confidence": "low",
                }
            )

        # 检测插件模式
        if any(
            (self.repo_path / "plugins").exists(),
            (self.repo_path / "extensions").exists(),
        ):
            patterns.append(
                {
                    "name": "插件架构",
                    "confidence": "medium",
                }
            )

        # 检测 monorepo 模式
        if (self.repo_path / "packages").exists() or (self.repo_path / "apps").exists():
            patterns.append(
                {
                    "name": "Monorepo",
                    "confidence": "high",
                }
            )

        return patterns

    def generate_report(self) -> str:
        """生成架构分析报告"""
        analysis = self.analyze()

        lines = [
            "# 架构分析报告\n",
            f"> 分析目标: {self.repo_path.name}\n",
            "---",
            "\n## 目录结构概览",
            f"- 总目录数: {analysis['directory_structure']['total_dirs']}",
            f"- 总文件数: {analysis['directory_structure']['total_files']}",
            f"- 最大深度: {analysis['directory_structure']['depth']}",
        ]

        if analysis["directory_structure"]["root"]:
            lines.append("\n**根目录文件/目录:**")
            for item in analysis["directory_structure"]["root"]:
                icon = "📁" if item["type"] == "dir" else "📄"
                lines.append(f"- {icon} {item['name']}")

        if analysis["entry_points"]:
            lines.append("\n## 入口文件")
            for ep in analysis["entry_points"]:
                lines.append(f"- **{ep['type']}**: `{ep['file']}`")

        if analysis["modules"]:
            lines.append("\n## 模块结构")
            for module in analysis["modules"][:10]:
                lines.append(f"- `{module['name']}` ({module['type']})")

        if analysis["config_files"]:
            lines.append("\n## 配置文件")
            by_type = defaultdict(list)
            for cf in analysis["config_files"]:
                by_type[cf["type"]].append(cf["file"])

            for config_type, files in by_type.items():
                lines.append(f"\n### {config_type}")
                for f in files[:5]:
                    lines.append(f"- `{f}`")

        if analysis["patterns"]:
            lines.append("\n## 架构模式")
            for pattern in analysis["patterns"]:
                confidence = (
                    "🟢 高"
                    if pattern["confidence"] == "high"
                    else "🟡 中"
                    if pattern["confidence"] == "medium"
                    else "🔴 低"
                )
                lines.append(f"- {pattern['name']} ({confidence}置信度)")

        return "\n".join(lines)


def main():
    """测试入口"""
    import sys

    if len(sys.argv) < 2:
        print("用法: python -m analyzer.architecture <仓库路径>")
        sys.exit(1)

    repo_path = sys.argv[1]
    analyzer = ArchitectureAnalyzer(repo_path)
    print(analyzer.generate_report())


if __name__ == "__main__":
    main()
