"""
快速深度搜索 V2 - 快准全版（非流式）

核心改进:
- ⚡ 更快：纯异步架构 + 会话复用 + 并发提取
- 🎯 更准：智能评分 + 权威性优先 + 质量过滤
- 📚 更全：完整内容(5000字) + 元数据 + 深度嵌套

特性:
- 非流式返回 (一次返回所有结果)
- 深度嵌套 (默认3层)
- 智能评分系统
- 域名权威性评估
- 内容质量检测
"""

import asyncio
import logging
import re
import time
from urllib.parse import urlparse

import aiohttp
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)


class SearchResult:
    """搜索结果"""

    __slots__ = ["title", "url", "snippet", "content", "source", "score", "depth", "children", "metadata", "authority_score", "quality_score"]

    def __init__(
        self,
        title: str,
        url: str,
        snippet: str = "",
        content: str = "",
        source: str = "",
        score: float = 0.0,
        depth: int = 0,
        children: list["SearchResult"] = None,
        metadata: dict = None,
    ):
        self.title = title
        self.url = url
        self.snippet = snippet
        self.content = content
        self.source = source
        self.score = score
        self.depth = depth
        self.children = children or []
        self.metadata = metadata or {}
        self.authority_score = 0.0  # 权威性评分
        self.quality_score = 0.0  # 质量评分


class FastSearchEngineV2:
    """快速搜索引擎 V2 - 快准全版（非流式）"""

    # 权威域名白名单 (优先级高)
    AUTHORITY_DOMAINS = {
        "gov": ["gov.cn"],
        "edu": ["edu.cn"],
        "wiki": ["baike.baidu.com", "wikipedia.org", "zh.wikipedia.org"],
        "official": ["com.cn", ".cn/"],  # 官网
        "media": ["people.com.cn", "xinhuanet.com", "cctv.com", "sina.com.cn"],
    }

    # 低质量域名黑名单
    LOW_QUALITY_DOMAINS = [
        "zhihu.com",  # 知乎（需要登录）
        "weibo.com",  # 微博
        "tieba.baidu.com",  # 百度贴吧
    ]

    def __init__(self, max_concurrent: int = 150, max_depth: int = 3, level: str = "standard"):
        """
        初始化

        Args:
            max_concurrent: 最大并发数 (默认150)
            max_depth: 最大深度 (默认3层)
            level: 搜索级别 - 'quick'/'standard'/'deep'
        """
        self.max_concurrent = max_concurrent
        self.max_depth = max_depth
        self.level = level  # 搜索级别，控制内容提取策略
        self.session: aiohttp.ClientSession | None = None

        # 统计信息
        self.stats = {"search_time": 0, "extracted_pages": 0, "total_chars": 0, "filtered_results": 0}

    async def __aenter__(self):
        """创建高性能 HTTP 会话"""
        connector = aiohttp.TCPConnector(
            limit=200,  # 最大连接数
            ttl_dns_cache=300,  # DNS 缓存5分钟
            use_dns_cache=True,  # 启用DNS缓存
            force_close=False,  # 连接复用
            enable_cleanup_closed=True,
        )

        self.session = aiohttp.ClientSession(
            connector=connector,
            timeout=aiohttp.ClientTimeout(
                total=15,  # 总超时15秒
                connect=5,  # 连接超时5秒
                sock_read=10,  # 读取超时10秒
            ),
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """关闭会话"""
        if self.session:
            await self.session.close()

    async def search(
        self,
        query: str,
        max_results: int = 10,
        max_depth: int = 3,
        exclude_domains: list[str] = None,
        level: str = None,
    ) -> list[SearchResult]:
        """
        非流式搜索 - HTTP-first 分层策略

        Args:
            query: 搜索关键词
            max_results: 最大返回结果数
            max_depth: 最大深度
            exclude_domains: 排除的域名列表
            level: 搜索级别 - 'quick'(仅索引), 'standard'(浅提取), 'deep'(完整提取)

        Returns:
            List[SearchResult]: 搜索结果列表（包含内容和子链接）
        """
        start_time = time.time()
        effective_level = level or self.level

        if exclude_domains is None:
            exclude_domains = self.LOW_QUALITY_DOMAINS.copy()

        logger.info(f"[V2] 开始搜索：{query} | 结果数：{max_results} | 深度：{max_depth} | 级别：{effective_level}")

        try:
            # 阶段1: 搜索 API
            all_results = await self._licensed_api_search(query, max_results * 2)

            logger.info(f"[V2] Tier1 搜索完成：{len(all_results)} 条原始结果")

            if not all_results:
                return []

            # 阶段2: 过滤和去重
            filtered_results = self._filter_and_dedup(all_results, exclude_domains)[:max_results]
            logger.info(f"[V2] 过滤后：{len(filtered_results)} 条结果")

            # 阶段3: 条件性内容提取（HTTP-first 核心优化）
            if effective_level == "quick":
                # quick 模式：跳过内容提取，直接用搜索引擎返回的 snippet
                logger.info("[V2] quick 模式：跳过内容提取")
                for r in filtered_results:
                    # snippet 已有，content 用 snippet 充当（最多 500 字）
                    if not r.content and r.snippet:
                        r.content = r.snippet[:500]
            else:
                # standard / deep 模式：并发提取页面内容
                extract_depth = 0 if effective_level == "standard" else max_depth
                extract_tasks = []
                for result in filtered_results:
                    result.depth = 0
                    extract_tasks.append(self._extract_with_children(result, extract_depth))

                await asyncio.gather(*extract_tasks, return_exceptions=True)

            # 阶段4: 智能评分
            self._score_all_results(filtered_results, query)

            # 阶段5: 排序并返回
            filtered_results.sort(key=lambda x: x.score, reverse=True)
            final_results = filtered_results[:max_results]

            elapsed = time.time() - start_time
            self.stats["search_time"] = elapsed
            logger.info(f"[V2] 搜索完成 | 耗时：{elapsed:.2f}s | 结果：{len(final_results)}")

            return final_results

        except Exception as e:
            logger.error(f"[V2] 搜索失败：{e}")
            raise

    async def _licensed_api_search(self, query: str, max_results: int) -> list[SearchResult]:
        """Search via configured providers (Tavily / InfoQuest / Firecrawl / …)."""
        try:
            from evoflow.community.baidu_search.tools import _api_licensed_search

            loop = asyncio.get_event_loop()
            raw_results = await loop.run_in_executor(
                None, lambda: _api_licensed_search(query, max_results)
            )
            return [
                SearchResult(
                    title=r.get("title", ""),
                    url=r.get("href", ""),
                    snippet=r.get("body", ""),
                    source=str(r.get("_engine") or "api"),
                )
                for r in raw_results[:max_results]
            ]
        except Exception as e:
            logger.error(f"[V2] Licensed API search failed: {e}")
            return []

    def _filter_and_dedup(self, results: list[SearchResult], exclude_domains: list[str]) -> list[SearchResult]:
        """过滤和去重"""
        seen_urls = set()
        filtered = []

        for result in results:
            domain = self._get_domain(result.url)

            # 过滤低质量域名
            if any(exclude in domain for exclude in exclude_domains):
                self.stats["filtered_results"] += 1
                continue

            # URL 去重
            normalized_url = result.url.rstrip("/")
            if normalized_url not in seen_urls:
                seen_urls.add(normalized_url)

                # 计算初始权威性评分
                result.authority_score = self._calculate_authority(domain)

                filtered.append(result)

        return filtered

    async def _extract_with_children(self, parent: SearchResult, max_depth: int) -> None:
        """递归提取内容和子链接（并发优化）"""
        try:
            # 提取主页面内容
            content, metadata = await self._extract_page_fast(parent.url)

            if content:
                parent.content = content[:5000]  # 5000 字（更全）
                parent.metadata.update(metadata)
                self.stats["extracted_pages"] += 1
                self.stats["total_chars"] += len(content)

                logger.info(f"[V2] ✓ 提取完成：{parent.url[:60]}... ({len(content)} 字)")

            # 如果还有深度，提取子链接
            if max_depth > 1 and content:
                child_urls = self._extract_smart_links(content, parent.url, max_count=5)

                if child_urls:
                    # 并发提取子链接（更快）
                    child_tasks = []
                    children = []

                    for idx, url in enumerate(child_urls[:max_depth]):
                        child = SearchResult(title=f"相关链接 {idx + 1}", url=url, depth=parent.depth + 1)
                        children.append(child)
                        child_tasks.append(self._extract_with_children(child, max_depth - 1))

                    # 并发执行
                    await asyncio.gather(*child_tasks, return_exceptions=True)

                    parent.children.extend(children)

        except Exception as e:
            logger.error(f"[V2] 提取失败：{parent.url} | 错误：{e}")

    async def _extract_page_fast(self, url: str) -> tuple[str, dict]:
        """
        快速提取页面内容（纯异步，更快的实现）

        Returns:
            tuple: (content_text, metadata_dict)
        """
        if not self.session:
            return "", {}

        try:
            async with self.session.get(url) as response:
                html = await response.text(errors="ignore")

                soup = BeautifulSoup(html, "html.parser")

                # 清理无用标签
                for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
                    tag.decompose()

                # 提取正文文本
                content = soup.get_text(separator="\n", strip=True)

                # 提取元数据（更全）
                metadata = {}

                # 页面描述
                desc_meta = soup.find("meta", attrs={"name": "description"})
                if desc_meta and desc_meta.get("content"):
                    metadata["description"] = desc_meta["content"][:500]

                # 作者信息
                author_elem = soup.select_one('[rel="author"], .author, .byline')
                if author_elem:
                    metadata["author"] = author_elem.get_text(strip=True)[:100]

                # 发布日期
                date_elem = soup.find("time") or soup.find(attrs={"itemprop": "datePublished"})
                if date_elem:
                    metadata["publish_date"] = date_elem.get("datetime", "") or date_elem.get_text(strip=True)[:50]

                # OG 标签
                og_title = soup.find("meta", attrs={"property": "og:title"})
                if og_title and og_title.get("content"):
                    metadata["og_title"] = og_title["content"][:200]

                return content, metadata

        except Exception as e:
            logger.debug(f"[V2] 页面提取失败：{url} | {e}")
            return "", {}

    def _extract_smart_links(self, content: str, base_url: str, max_count: int = 5) -> list[str]:
        """智能提取相关链接（只提取高质量链接）"""
        links = set()

        # 从 Markdown 格式提取
        md_pattern = r"\[([^\]]+)\]\(([^)]+)\)"
        for match in re.finditer(md_pattern, content):
            url = match.group(2).strip()
            if url.startswith("http") and self._is_high_quality_link(url):
                links.add(url)
                if len(links) >= max_count:
                    break

        # 从 HTML 格式提取（如果还没有足够的链接）
        if len(links) < max_count:
            html_pattern = r'href=["\']([^"\']+)["\']'
            for match in re.finditer(html_pattern, content):
                url = match.group(1).strip()
                if url.startswith("http") and self._is_high_quality_link(url):
                    links.add(url)
                    if len(links) >= max_count:
                        break

        return list(links)[:max_count]

    def _is_high_quality_link(self, url: str) -> bool:
        """判断是否为高质量链接"""
        domain = self._get_domain(url)

        # 排除低质量域名
        if any(low in domain for low in self.LOW_QUALITY_DOMAINS):
            return False

        # 排除非标准协议
        if not url.startswith(("http://", "https://")):
            return False

        # 排除过短的URL（可能是锚点或相对路径）
        if len(url) < 20:
            return False

        return True

    def _calculate_authority(self, domain: str) -> float:
        """计算域名权威性评分（0-1）"""
        score = 0.5  # 基础分

        # 政府网站
        if any(gov in domain for gov in self.AUTHORITY_DOMAINS["gov"]):
            score = 1.0
        # 教育机构
        elif any(edu in domain for edu in self.AUTHORITY_DOMAINS["edu"]):
            score = 0.95
        # 维基百科类
        elif any(wiki in domain for wiki in self.AUTHORITY_DOMAINS["wiki"]):
            score = 0.9
        # 知名媒体
        elif any(media in domain for media in self.AUTHORITY_DOMAINS["media"]):
            score = 0.85
        # 官网（.com.cn 或 .cn）
        elif any(official in domain for official in self.AUTHORITY_DOMAINS["official"]):
            score = 0.8

        return score

    def _score_all_results(self, results: list[SearchResult], query: str) -> None:
        """BM25-inspired relevance scoring for search results.

        Weighting scheme:
        - Title matches: 3x boost (most important signal)
        - Snippet matches: 2x boost (summary relevance)
        - Content matches: 1x boost (body text support)

        Plus authority and quality signals for ranking refinement.
        """
        if not query or not query.strip():
            # Fallback: preserve existing scores
            return

        import math

        query_lower = query.lower().strip()
        # Extract meaningful terms (length >= 2 to skip stop words like 'a', 'in', 'of')
        query_terms = set(t for t in query_lower.split() if len(t) >= 2)

        # If no meaningful terms, use full query string
        if not query_terms:
            query_terms = {query_lower}

        for result in results:
            title_text = (result.title or "").lower()
            snippet_text = (result.snippet or "").lower()
            content_text = (result.content or "").lower()[:2000]  # Only first 2KB for performance

            bm25_score = 0.0

            # Field weights: title=3.0, snippet=2.0, content=1.0
            fields = [
                (title_text, 3.0),
                (snippet_text, 2.0),
                (content_text, 1.0),
            ]

            for text, weight in fields:
                if not text:
                    continue

                text_len = len(text)
                avg_field_len = 200  # Approximate average field length

                # Normalize by average document length (BM25 IDF component)
                k1 = 1.5  # Term frequency saturation parameter
                b = 0.75  # Length normalization parameter

                for term in query_terms:
                    # Count term occurrences in this field
                    count = text.count(term)

                    if count > 0:
                        # BM25 TF formula: (count * (k1 + 1)) / (count + k1 * (1 - b + b * dl/avgdl))
                        tf_component = (count * (k1 + 1)) / (count + k1 * (1 - b + b * text_len / avg_field_len))

                        # IDF approximation: log(N/df+1) — simplified as all docs have equal df
                        idf_component = math.log(1 + 1.5 / (count + 0.5))

                        bm25_score += weight * tf_component * idf_component

            # Combine BM25 score with authority and quality signals
            authority_bonus = getattr(result, "authority_score", 0) * 0.15
            quality = self._calculate_content_quality(result)
            result.quality_score = quality
            quality_bonus = quality * 0.08

            # Final composite score (normalized to ~0-1 range)
            raw_total = bm25_score + authority_bonus + quality_bonus
            result.score = min(raw_total / 6.0, 1.0)  # Scale factor based on typical max score

    def _calculate_content_quality(self, result: SearchResult) -> float:
        """计算内容质量评分（0-1）"""
        quality = 0.0

        # 内容长度
        content_len = len(result.content)
        if content_len > 2000:
            quality += 0.4
        elif content_len > 1000:
            quality += 0.3
        elif content_len > 500:
            quality += 0.2
        elif content_len > 100:
            quality += 0.1

        # 有元数据
        if result.metadata:
            quality += 0.2

        # 有作者
        if result.metadata.get("author"):
            quality += 0.15

        # 有发布日期
        if result.metadata.get("publish_date"):
            quality += 0.15

        # 标题质量
        if 10 <= len(result.title) <= 80:
            quality += 0.1

        return min(quality, 1.0)

    def _get_domain(self, url: str) -> str:
        """提取域名"""
        try:
            parsed = urlparse(url)
            return parsed.netloc.lower()
        except Exception:
            return ""

    def get_stats(self) -> dict:
        """获取统计信息"""
        return self.stats


# 便捷函数（同步调用）
def fast_search_v2(
    query: str,
    max_results: int = 10,
    max_depth: int = 2,
    exclude_domains: list[str] = None,
    level: str = "standard",
) -> list[SearchResult]:
    """
    快速搜索 V2（同步接口）— 支持 HTTP-first 分层策略

    Args:
        query: 搜索关键词
        max_results: 最大返回结果数
        max_depth: 最大深度 (quick=0, standard=1, deep=2-3)
        exclude_domains: 排除的域名列表
        level: 搜索深度 - 'quick'(2-5s), 'standard'(5-8s), 'deep'(10-15s)

    Returns:
        List[SearchResult]: 搜索结果列表

    性能优化 (HTTP-first 策略):
    - quick: 仅搜索索引，不做内容提取 → 最快
    - standard: 搜索 + 浅层内容提取(1层) → 平衡
    - deep: 完整搜索 + 深层提取(2-3层) → 最全但慢
    """
    # 根据级别调整深度参数
    depth_map = {"quick": 0, "standard": 1, "deep": max(max_depth, 2)}
    effective_depth = depth_map.get(level, max_depth)

    async def run_search():
        async with FastSearchEngineV2(
            max_concurrent=150,
            max_depth=effective_depth,
            level=level,
        ) as engine:
            results = await engine.search(
                query=query,
                max_results=max_results,
                max_depth=effective_depth,
                exclude_domains=exclude_domains,
                level=level,
            )
            return results

    return asyncio.run(run_search())


# 异步函数
async def fast_search_v2_async(
    query: str,
    max_results: int = 10,
    max_depth: int = 3,
    exclude_domains: list[str] = None,
) -> list[SearchResult]:
    """
    快速搜索 V2（异步接口）

    Returns:
        List[SearchResult]: 搜索结果列表
    """
    async with FastSearchEngineV2(max_concurrent=150, max_depth=max_depth) as engine:
        results = await engine.search(query=query, max_results=max_results, max_depth=max_depth, exclude_domains=exclude_domains)
        return results


# CLI 测试入口
if __name__ == "__main__":
    print("=" * 80)
    print("⚡ 快速深度搜索 V2 - 快准全版测试（非流式）")
    print("=" * 80)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

    query = "国华人寿"
    print(f"\n🔍 搜索关键词：{query}")
    print("⚡ 核心特性：更快 | 更准 | 更全\n")

    # 使用同步接口（推荐）
    print("📊 开始搜索...\n")
    results = fast_search_v2(query, max_results=5, max_depth=2)

    # 显示结果
    print(f"\n{'=' * 80}")
    print(f"📋 搜索结果（共 {len(results)} 条）")
    print("=" * 80)

    for i, result in enumerate(results, 1):
        print(f"\n{i}. [{result.source}] {result.title}")
        print(f"   🔗 {result.url}")
        print(f"   ⭐ 综合评分：{result.score:.3f}")
        print(f"   🏛️ 权威性：{result.authority_score:.3f}")
        print(f"   💎 质量：{result.quality_score:.3f}")
        print(f"   📏 深度：{result.depth} 层")

        if result.content:
            print(f"   📝 内容长度：{len(result.content)} 字")
            print(f"   📄 内容摘要：{result.content[:250]}...")

        if result.metadata:
            meta_info = []
            if result.metadata.get("author"):
                meta_info.append(f"作者：{result.metadata['author']}")
            if result.metadata.get("publish_date"):
                meta_info.append(f"发布日期：{result.metadata['publish_date']}")
            if result.metadata.get("description"):
                meta_info.append(f"描述：{result.metadata['description'][:100]}...")
            if meta_info:
                print(f"   📋 元数据：{' | '.join(meta_info)}")

        if result.children:
            print(f"   🔗 子链接：{len(result.children)} 个")
            for j, child in enumerate(result.children[:3], 1):
                print(f"      {j}. {child.url[:70]}...")

    # 显示统计信息
    print("\n" + "=" * 80)
    print("📈 性能统计")
    print("=" * 80)

    # 使用异步上下文获取统计信息
    async def show_stats():
        async with FastSearchEngineV2() as engine:
            stats = engine.get_stats()
            print(f"⏱️ 总耗时：{stats.get('search_time', 'N/A')}s")
            print(f"📄 提取页面：{stats.get('extracted_pages', 0)} 个")
            print(f"📝 总字符数：{stats.get('total_chars', 0):,} 字")
            print(f"🚫 过滤结果：{stats.get('filtered_results', 0)} 条")
            print(f"✅ 最终结果：{len(results)} 条")

    asyncio.run(show_stats())
