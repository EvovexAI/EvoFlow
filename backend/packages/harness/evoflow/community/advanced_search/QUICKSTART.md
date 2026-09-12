# 🚀 高级搜索工具 - 快速开始

## ✅ 测试完成！代码已跑通！

**测试时间**: 2026-04-10  
**测试状态**: ✅ 全部通过  
**性能表现**: 33-41 秒 (标准搜索), <1 秒 (缓存命中)

---

## 📦 快速使用

### 方法 1: 命令行 (最简单)

```bash
# 设置环境变量 (提升速度)
$env:EVOFLOW_BAIDU_PAGE_CONTENT_CHARS="0"
$env:PYTHONPATH="d:/github/evoflow/backend/packages/harness"

# 运行搜索
python d:/github/evoflow/backend/packages/harness/evoflow/community/advanced_search/tools.py "搜索关键词" 结果数量
```

**示例**:
```bash
# 搜索"人工智能"，返回 5 条结果
$env:EVOFLOW_BAIDU_PAGE_CONTENT_CHARS="0"
$env:PYTHONPATH="d:/github/evoflow/backend/packages/harness"
python d:/github/evoflow/backend/packages/harness/evoflow/community/advanced_search/tools.py "人工智能" 5
```

### 方法 2: Python API

```python
import sys
sys.path.insert(0, 'd:/github/evoflow/backend/packages/harness')

from evoflow.community.advanced_search.tools import quick_search, standard_search, deep_search

# 快速搜索 (1-2 秒)
results = quick_search("天气怎么样", max_results=3)

# 标准搜索 (30-40 秒)
results = standard_search("机器学习教程", max_results=10)

# 深度搜索 (60-90 秒)
results = deep_search("量子计算研究", max_results=15)

# 打印结果
for r in results:
    print(f"{r.title} - {r.url} (评分：{r.score})")
```

---

## 🎯 三种搜索模式

### 1. quick - 快速搜索

```python
from evoflow.community.advanced_search.tools import quick_search

results = quick_search("北京天气", max_results=5)
```

- ⚡ **速度**: 1-2 秒
- 📊 **引擎**: 单引擎 (百度)
- 💾 **缓存**: 启用
- 🎯 **适用**: 实时交互、简单查询

---

### 2. standard - 标准搜索 (推荐)

```python
from evoflow.community.advanced_search.tools import standard_search

results = standard_search("人工智能最新进展", max_results=10)
```

- ⚡ **速度**: 30-40 秒 (优化后)
- 📊 **引擎**: 双引擎 (百度 + Bing)
- 💾 **缓存**: 启用
- 🎯 **适用**: 日常查询、一般研究

---

### 3. deep - 深度搜索

```python
from evoflow.community.advanced_search.tools import deep_search

results = deep_search("机器学习论文 2024", max_results=15)
```

- ⚡ **速度**: 60-90 秒
- 📊 **引擎**: 三引擎 (百度+Bing+DuckDuckGo)
- 💾 **缓存**: 启用
- 🎯 **适用**: 深度研究、学术查询

---

## 🔧 性能优化

### 关键配置

```bash
# 1. 禁用深度页面提取 (大幅提升速度！)
$env:EVOFLOW_BAIDU_PAGE_CONTENT_CHARS="0"

# 2. 设置 PYTHONPATH
$env:PYTHONPATH="d:/github/evoflow/backend/packages/harness"
```

### 缓存加速

```bash
# 第一次搜索 (33 秒)
python advanced_search/tools.py "北京天气" 5

# 第二次搜索 (<1 秒，缓存命中！)
python advanced_search/tools.py "北京天气" 5
```

---

## 📊 测试结果

### 测试 1: "北京天气"
```
✅ 成功 | 耗时：33.50 秒 | 结果：5 条 | 平均评分：0.64
```

### 测试 2: "机器学习教程"
```
✅ 成功 | 耗时：41.44 秒 | 结果：10 条 | 平均评分：0.61
```

### 测试 3: 缓存测试
```
✅ 缓存命中 | 耗时：<1 秒 | 结果：5 条
```

---

## 🎯 核心特性

### ✅ 高效
- 并行搜索 (百度 + Bing + DuckDuckGo)
- 多级缓存 (内存 + 文件 + 浏览器)
- 结果去重 + 多样性控制

### ✅ 快速
- 优化后速度：30-40 秒
- 缓存命中：<1 秒
- 加速比：>30 倍

### ✅ 免费
- 源码可见（非 OSI 开源许可证）
- 使用现有内嵌工具
- 零 API Key 依赖

### ✅ 精准
- 多维度质量评分
- 智能排序算法
- 权威性 + 时效性 + 完整性

---

## 📁 文件位置

- 📖 **设计文档**: [advanced-search-design.md](../../../advanced-search-design.md)
- 🛠️ **源代码**: [tools.py](./tools.py)
- 📝 **使用指南**: [USAGE.md](./USAGE.md)
- 📋 **测试报告**: [TEST_REPORT.md](./TEST_REPORT.md)
- ⚙️ **配置示例**: [config.example.yaml](./config.example.yaml)
- 🚀 **快速开始**: [QUICKSTART.md](./QUICKSTART.md)

---

## 💡 使用技巧

### 技巧 1: 使用缓存

```bash
# 相同查询会直接返回缓存，几乎零延迟
python advanced_search/tools.py "人工智能" 10  # 第一次 33 秒
python advanced_search/tools.py "人工智能" 10  # 第二次 <1 秒
```

### 技巧 2: 选择合适的模式

```python
# 实时交互 → quick
results = quick_search("今天星期几")

# 一般查询 → standard
results = standard_search("深度学习教程")

# 深度研究 → deep
results = deep_search("量子计算最新进展")
```

### 技巧 3: 调整结果数量

```python
# 少量结果 (更快)
results = quick_search("天气", max_results=3)

# 大量结果 (更全面)
results = standard_search("AI 行业报告", max_results=20)
```

---

## 🐛 常见问题

### Q1: 为什么第一次搜索比较慢？

**A**: 第一次搜索需要：
1. 启动搜索引擎
2. 并行查询多个引擎
3. 抓取页面内容

**解决方案**:
- 设置 `EVOFLOW_BAIDU_PAGE_CONTENT_CHARS=0` 禁用深度提取
- 使用缓存，第二次查询会非常快

### Q2: 如何提升搜索速度？

**A**: 三种方法：
1. 使用 `quick_search` 模式 (最快)
2. 设置 `EVOFLOW_BAIDU_PAGE_CONTENT_CHARS=0` (禁用深度提取)
3. 充分利用缓存 (相同查询<1 秒)

### Q3: 缓存存在哪里？

**A**: 
- 路径：`.cache/search/`
- TTL: 7 天
- 大小：最多 1000 条

---

## 📞 获取帮助

如果遇到问题：

1. 查看 [TEST_REPORT.md](./TEST_REPORT.md) 了解测试结果
2. 查看 [USAGE.md](./USAGE.md) 了解详细用法
3. 查看 [advanced-search-design.md](../../../advanced-search-design.md) 了解架构设计

---

## 🎉 开始使用

现在就开始使用高级搜索工具吧！

```bash
# 复制粘贴这个命令，立即开始
$env:EVOFLOW_BAIDU_PAGE_CONTENT_CHARS="0"
$env:PYTHONPATH="d:/github/evoflow/backend/packages/harness"
python d:/github/evoflow/backend/packages/harness/evoflow/community/advanced_search/tools.py "你的搜索词" 10
```

**享受高效、快速、精准的搜索体验！** 🚀
