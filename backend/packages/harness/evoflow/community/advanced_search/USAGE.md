# 高级搜索工具使用指南

## 📦 安装依赖

```bash
# 核心依赖
pip install aiohttp asyncio-playwright readability-lxml

# 搜索引擎依赖
pip install ddgs  # DuckDuckGo 非官方 API
pip install playwright  # 真浏览器搜索
playwright install  # 安装浏览器

# 可选依赖 (提升质量)
pip install sentence-transformers  # 语义搜索
pip install rank-bm25  # BM25 算法
```

---

## 🚀 快速开始

### 1. **Python API 使用**

```python
from evoflow.community.advanced_search.tools import (
    quick_search,
    standard_search,
    deep_search,
)

# 快速搜索 (1-2 秒)
results = quick_search("人工智能最新进展", max_results=5)
for result in results:
    print(f"标题：{result.title}")
    print(f"链接：{result.url}")
    print(f"评分：{result.score}")
    print()

# 标准搜索 (3-5 秒)
results = standard_search("深度学习教程", max_results=10)

# 深度搜索 (10-15 秒，包含完整内容提取)
results = deep_search("机器学习论文 2024", max_results=10)
for result in results:
    print(f"标题：{result.title}")
    print(f"内容：{result.content[:500]}")
    print()
```

### 2. **使用 AdvancedSearchEngine 类**

```python
from evoflow.community.advanced_search.tools import AdvancedSearchEngine

# 创建引擎实例
engine = AdvancedSearchEngine(
    level='deep',      # 搜索深度：quick/standard/deep
    use_cache=True,    # 启用缓存
    diversity=True,    # 结果多样性
)

# 执行搜索
results = engine.search(
    query="量子计算",
    max_results=10,
    time_range='month',  # 时间范围：day/week/month/year
)

# 格式化输出
formatted = engine.search_formatted(
    query="量子计算",
    max_results=10,
    format='markdown',  # json/markdown/text
)
print(formatted)
```

### 3. **命令行使用**

```bash
# 基本用法
python advanced_search.py "人工智能最新进展"

# 指定结果数量
python advanced_search.py "深度学习教程" 15

# 查看帮助
python advanced_search.py --help
```

---

## 🔧 配置选项

### 在 config.yaml 中配置

```yaml
tools:
  # 高级搜索工具
  - name: advanced_search
    group: web
    use: evoflow.community.advanced_search.tools:advanced_search_tool
    level: standard          # 搜索深度
    max_results: 10          # 最大结果数
    use_cache: true          # 启用缓存
    cache_ttl_days: 7        # 缓存有效期
    diversity: true          # 结果多样性
    max_per_domain: 3        # 每域名最多结果数
  
  # 快速搜索工具
  - name: quick_search
    group: web
    use: evoflow.community.advanced_search.tools:quick_search_tool
    max_results: 5
  
  # 深度搜索工具
  - name: deep_search
    group: web
    use: evoflow.community.advanced_search.tools:deep_search_tool
    max_results: 15
    extract_content: true
    max_content_chars: 4096
```

---

## 📊 搜索级别对比

| 级别 | 耗时 | 引擎数 | 内容提取 | 适用场景 |
|------|------|--------|----------|----------|
| **quick** | 1-2 秒 | 1 (百度) | 否 | 实时交互、简单查询 |
| **standard** | 3-5 秒 | 2 (百度+Bing) | 部分 | 一般搜索、日常使用 |
| **deep** | 10-15 秒 | 3 (百度+Bing+DDG) | 完整 | 研究任务、深度分析 |

---

## 🎯 使用场景

### 场景 1: **实时问答**
```python
# 使用快速搜索
results = quick_search("今天天气怎么样", max_results=3)
```

### 场景 2: **知识查询**
```python
# 使用标准搜索
results = standard_search("量子力学基本原理", max_results=10)
```

### 场景 3: **学术研究**
```python
# 使用深度搜索 + 时间过滤
results = deep_search(
    "机器学习 综述论文",
    max_results=15,
    time_range='year',
)
```

### 场景 4: **新闻监控**
```python
# 使用标准搜索 + 时间过滤
results = standard_search(
    "AI 行业融资",
    max_results=20,
    time_range='week',
)
```

### 场景 5: **竞品分析**
```python
# 使用深度搜索 + 域名过滤
engine = AdvancedSearchEngine(level='deep')
results = engine.search(
    query="电动汽车技术对比",
    max_results=15,
    domain_filter=['gov.cn', 'edu.cn', 'autohome.com.cn'],
)
```

---

## 🏗️ 架构说明

### 核心组件

1. **QueryOptimizer** - 查询优化器
   - 关键词扩展
   - 同义词生成
   - 意图识别

2. **ParallelSearchEngine** - 并行搜索引擎
   - 多引擎并行执行
   - 结果聚合去重
   - 深度内容提取

3. **QualityScorer** - 质量评分器
   - 相关性评分
   - 权威性评分
   - 时效性评分
   - 完整性评分

4. **SearchCache** - 多级缓存
   - L1: 内存缓存 (LRU, 1000 条)
   - L2: 文件缓存 (7 天 TTL)
   - L3: 浏览器缓存 (Playwright)

5. **IntelligentRanker** - 智能排序
   - 多目标优化
   - 来源多样性
   - 类型多样性

---

## 📈 性能优化

### 1. **启用缓存**
```python
engine = AdvancedSearchEngine(use_cache=True)
# 相同查询会直接从缓存返回，毫秒级响应
```

### 2. **选择合适的搜索级别**
```python
# 实时交互场景 - 使用 quick
results = quick_search(query)

# 一般查询 - 使用 standard
results = standard_search(query)

# 深度研究 - 使用 deep
results = deep_search(query)
```

### 3. **并发控制**
```python
# 批量查询时使用 asyncio.gather 并发
import asyncio

queries = ["查询 1", "查询 2", "查询 3"]
tasks = [asyncio.to_thread(standard_search, q) for q in queries]
results = await asyncio.gather(*tasks)
```

---

## 🔍 结果质量评分说明

### 评分维度

```python
综合评分 = 0.4*相关性 + 0.3*权威性 + 0.2*时效性 + 0.1*完整性
```

### 权威性权重

| 域名类型 | 权重 |
|---------|------|
| gov.cn | 1.0 |
| edu.cn | 0.95 |
| ac.cn | 0.9 |
| wikipedia.org | 0.95 |
| baike.baidu.com | 0.8 |
| zhihu.com | 0.7 |
| github.com | 0.75 |

### 时效性权重

| 发布时间 | 权重 |
|---------|------|
| 7 天内 | 1.0 |
| 30 天内 | 0.8 |
| 90 天内 | 0.6 |
| 1 年内 | 0.4 |
| 超过 1 年 | 0.2 |

---

## 🛠️ 高级功能

### 1. **自定义评分权重**
```python
from evoflow.community.advanced_search.tools import QualityScorer

scorer = QualityScorer()
scorer.domain_weights['custom.com'] = 0.9
```

### 2. **查询扩展**
```python
from evoflow.community.advanced_search.tools import QueryOptimizer

optimizer = QueryOptimizer()
expansions = optimizer.expand_query("人工智能")
# 返回：['人工智能', '人工智能 2024 2025', 'site:gov.cn 人工智能']
```

### 3. **结果过滤**
```python
# 只保留高评分结果
high_quality = [r for r in results if r.score >= 0.7]

# 只保留特定域名
gov_results = [r for r in results if 'gov.cn' in r.url]

# 只保留近期内容
from datetime import datetime, timedelta
recent = [
    r for r in results 
    if r.publish_date and r.publish_date > datetime.now() - timedelta(days=30)
]
```

---

## 📝 输出格式示例

### JSON 格式
```json
{
  "query": "人工智能",
  "level": "standard",
  "total_results": 10,
  "results": [
    {
      "title": "人工智能发展现状",
      "url": "https://example.com/article",
      "snippet": "摘要内容...",
      "content": "完整内容...",
      "score": 0.85,
      "source": "baidu"
    }
  ]
}
```

### Markdown 格式
```markdown
# 搜索结果：人工智能

## 1. 人工智能发展现状
**来源**: https://example.com/article  
**评分**: 0.85  

摘要内容...

## 2. 机器学习教程
**来源**: https://example.com/tutorial  
**评分**: 0.78  

摘要内容...
```

---

## ⚠️ 注意事项

### 1. **速率限制**
- 避免短时间内大量请求同一搜索引擎
- 建议使用缓存减少重复查询
- 生产环境配置合适的超时时间

### 2. **内容提取**
- 深度搜索会访问每个结果页面，耗时较长
- 部分网站可能反爬虫，导致提取失败
- 建议设置合理的超时时间

### 3. **缓存管理**
- 定期清理过期缓存
- 缓存目录默认在 `.cache/search`
- 可根据需要调整 TTL

---

## 🐛 故障排查

### 问题 1: 搜索结果为空
```python
# 检查网络连接
# 检查搜索引擎是否可用
# 尝试更换查询关键词
# 查看日志输出
logging.basicConfig(level=logging.DEBUG)
```

### 问题 2: 缓存未命中
```python
# 检查缓存目录权限
# 确认缓存 TTL 设置
# 查看缓存文件大小
```

### 问题 3: 内容提取失败
```python
# 检查 Playwright 是否安装
# 确认网页是否可访问
# 查看提取错误日志
```

---

## 📚 相关文档

- [高级搜索设计文档](../../../advanced-search-design.md)
- [配置示例](./config.example.yaml)
- [源代码](./tools.py)

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 改进本工具！

---

## 📄 许可证

MIT License
