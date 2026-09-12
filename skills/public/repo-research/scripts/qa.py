#!/usr/bin/env python3
"""
智能问答模块 - 让用户能用自然语言询问仓库问题

这个模块定义了常见问题类型和回答框架。
实际的 LLM 调用由技能工作流中的 Claude Code 完成。
"""

import json
import re
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass


@dataclass
class Question:
    """问题数据类"""

    original: str
    intent: str  # 意图分类
    entities: Dict  # 提取的实体
    context_files: List[str]  # 需要读取的文件


class QuestionClassifier:
    """问题意图分类器"""

    # 意图模式
    INTENT_PATTERNS = {
        "overview": [
            r"做什么的",
            r"是什么项目",
            r"介绍",
            r"功能",
            r"这个项目",
        ],
        "architecture": [
            r"架构",
            r"结构",
            r"模块",
            r"组织",
            r"设计",
        ],
        "usage": [
            r"使用",
            r"怎么用",
            r"如何",
            r"入门",
            r"安装",
            r"运行",
        ],
        "api": [
            r"API",
            r"接口",
            r"函数",
            r"方法",
            r"调用",
        ],
        "dependencies": [
            r"依赖",
            r"需要",
            r"安装",
            r"包",
        ],
        "compare": [
            r"对比",
            r"区别",
            r"不同",
            r"比较",
            r"优势",
            r"劣势",
        ],
    }

    @classmethod
    def classify(cls, question: str) -> Question:
        """分类问题意图

        Args:
            question: 用户问题

        Returns:
            解析后的问题对象
        """
        question_lower = question.lower()

        # 识别意图
        intent = "general"
        for intent_name, patterns in cls.INTENT_PATTERNS.items():
            for pattern in patterns:
                if re.search(pattern, question_lower):
                    intent = intent_name
                    break

        # 提取实体
        entities = cls._extract_entities(question)

        # 确定需要读取的文件
        context_files = cls._get_context_files(intent, entities)

        return Question(
            original=question,
            intent=intent,
            entities=entities,
            context_files=context_files,
        )

    @staticmethod
    def _extract_entities(question: str) -> Dict:
        """提取问题中的实体"""
        entities = {
            "features": [],
            "components": [],
            "files": [],
        }

        # 提取功能关键词
        feature_keywords = [
            "登录",
            "认证",
            "支付",
            "导出",
            "导入",
            "搜索",
            "上传",
            "下载",
        ]
        for kw in feature_keywords:
            if kw in question:
                entities["features"].append(kw)

        # 提取组件名称（如果有引号或反引号）
        component_pattern = r'[`"\']([^`"\']+)[`"\']'
        matches = re.findall(component_pattern, question)
        entities["components"].extend(matches)

        return entities

    @staticmethod
    def _get_context_files(intent: str, entities: Dict) -> List[str]:
        """根据意图确定需要读取的文件"""
        context_map = {
            "overview": ["README.md", "package.json", "pyproject.toml"],
            "architecture": ["README.md", "ARCHITECTURE.md", "docs/"],
            "usage": ["README.md", "docs/", "examples/"],
            "api": ["README.md", "docs/api", "src/"],
            "dependencies": [
                "package.json",
                "requirements.txt",
                "go.mod",
                "Cargo.toml",
            ],
            "compare": ["README.md"],
            "general": ["README.md"],
        }

        return context_map.get(intent, ["README.md"])


class QATemplate:
    """问答模板 - 提供结构化的回答框架"""

    OVERVIEW_TEMPLATE = """
## 项目概述

**{name}** 是一个 {description}

### 核心功能
{features}

### 技术栈
- 主要语言: {language}
- 框架/库: {frameworks}
### 适用场景
{use_cases}
"""

    ARCHITECTURE_TEMPLATE = """
## 架构分析

### 目录结构
```
{structure}
```

### 模块划分
{modules}

### 架构模式
{patterns}
"""

    USAGE_TEMPLATE = """
## 使用指南

### 快速开始
```bash
{install_command}
```

### 基本用法
{examples}
"""

    @classmethod
    def format_overview(
        cls, repo_name: str, readme_content: str, package_info: Dict
    ) -> str:
        """格式化项目概述回答"""
        # 简单提取 README 摘要
        description = "一个开源项目"

        # 从 README 提取第一段
        lines = readme_content.split("\n")
        for line in lines:
            if line.strip() and not line.startswith("#"):
                description = line.strip()
                break

        # 提取语言
        language = package_info.get("language", "未知")

        # 提取依赖/框架
        frameworks = list(package_info.get("dependencies", {}).keys())[:5]

        return cls.OVERVIEW_TEMPLATE.format(
            name=repo_name,
            description=description,
            features="- " + "\n- ".join(package_info.get("features", ["待分析"])),
            language=language,
            frameworks=", ".join(frameworks) if frameworks else "待分析",
            use_cases="见下方 README 详情",
        )

    @classmethod
    def format_structure(cls, structure: Dict) -> str:
        """格式化架构分析回答"""
        lines = []
        for item in structure.get("root", []):
            icon = "📁" if item["type"] == "dir" else "📄"
            lines.append(f"{icon} {item['name']}")

        return cls.ARCHITECTURE_TEMPLATE.format(
            structure="\n".join(lines),
            modules="见架构分析报告",
            patterns="待检测",
        )


class QAGenerator:
    """问答内容生成器 - 为技能工作流提供提示词"""

    # 标准问题库
    STANDARD_QUESTIONS = {
        "overview": [
            "这个项目是做什么的？",
            "这个项目有什么功能？",
            "能介绍一下这个项目吗？",
        ],
        "architecture": [
            "项目的架构是怎样的？",
            "模块是怎么组织的？",
            "目录结构是什么样的？",
        ],
        "usage": [
            "如何使用这个项目？",
            "如何安装和运行？",
            "有什么使用示例吗？",
        ],
        "api": [
            "有哪些 API 可用？",
            "如何调用这个功能？",
            "主要函数和类有哪些？",
        ],
    }

    @classmethod
    def generate_search_prompt(cls, question: str, repo_path: str) -> str:
        """生成代码搜索提示词

        Args:
            question: 用户问题
            repo_path: 仓库路径

        Returns:
            提示词
        """
        q = QuestionClassifier.classify(question)

        prompt = f"""你正在分析本地仓库: {repo_path}

用户问题: {question}
问题意图: {q.intent}

请根据以下步骤回答:

1. 先搜索/读取相关的代码文件
2. 分析代码逻辑
3. 用简洁易懂的语言回答用户问题

请直接给出回答,不需要列出搜索过程。
"""

        return prompt

    @classmethod
    def get_suggested_questions(cls) -> List[str]:
        """获取建议的问题列表"""
        questions = []
        for q_list in cls.STANDARD_QUESTIONS.values():
            questions.extend(q_list)
        return questions


def generate_question_prompt(question: str, repo_path: str) -> str:
    """便捷函数: 生成问答提示词"""
    return QAGenerator.generate_search_prompt(question, repo_path)


def main():
    """测试入口"""
    import sys

    if len(sys.argv) < 2:
        print("用法: python -m qa.py <问题>")
        sys.exit(1)

    question = " ".join(sys.argv[1:])
    q = QuestionClassifier.classify(question)

    print(f"原始问题: {q.original}")
    print(f"意图分类: {q.intent}")
    print(f"实体: {q.entities}")
    print(f"需要读取的文件: {q.context_files}")
    print(f"\n建议的搜索提示词:\n{generate_question_prompt(question, './')}")


if __name__ == "__main__":
    main()
