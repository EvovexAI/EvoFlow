"""
测试新的 web_search_tool 接口（使用 FastSearchV2）
"""

import json
import os
import sys

# 添加路径
sys.path.insert(0, os.path.dirname(__file__))

from tools import web_search_tool


def test_web_search():
    """测试 web_search_tool"""
    print("=" * 80)
    print("🧪 测试新的 web_search_tool（FastSearchV2 版本）")
    print("=" * 80)

    query = "国华人寿"
    max_results = 3

    print(f"\n🔍 测试查询：{query}")
    print(f"📊 最大结果数：{max_results}\n")

    # 调用搜索工具（LangChain Tool 需要使用 .invoke()）
    try:
        # 方式1: 直接调用（如果还是函数）
        result_str = web_search_tool(query=query, max_results=max_results)
    except TypeError:
        # 方式2: 使用 .invoke() （如果是 LangChain Tool）
        from langchain_core.tools import StructuredTool

        if isinstance(web_search_tool, StructuredTool):
            result_str = web_search_tool.invoke({"query": query, "max_results": max_results})
        else:
            raise

    try:
        # 解析 JSON 结果
        result = json.loads(result_str)

        print("✅ 搜索成功！\n")
        print("=" * 80)
        print("📋 返回结果")
        print("=" * 80)

        # 显示基本信息
        print(f"\n📌 查询：{result.get('query', 'N/A')}")
        print(f"📊 总结果数：{result.get('total_results', 0)}")
        print(f"🚀 引擎版本：{result.get('_engine_version', 'Legacy')}")
        print(f"⚡ 特性：{', '.join(result.get('_features', []))}\n")

        # 显示每个结果
        results_list = result.get("results", [])
        for i, r in enumerate(results_list, 1):
            print(f"{'─' * 80}")
            print(f"{i}. {r.get('title', 'N/A')}")
            print(f"   🔗 URL：{r.get('url', 'N/A')[:80]}...")
            print(f"   ⭐ 智能评分：{r.get('_score', 'N/A')}")
            print(f"   🏛️ 权威性：{r.get('_authority', 'N/A')}")
            print(f"   💎 质量分：{r.get('_quality', 'N/A')}")

            content = r.get("content", "")
            if content:
                print(f"   📝 内容长度：{len(content)} 字")
                print(f"   📄 内容摘要：{content[:200]}...")
            else:
                print("   ⚠️ 无内容")
            print()

        print("=" * 80)
        print("✅ 测试完成！新搜索引擎已成功替换原百度搜索工具。")
        print("=" * 80)

        return True

    except Exception as e:
        print(f"\n❌ 解析结果失败：{e}")
        print(f"\n原始返回：\n{result_str[:500]}...")
        return False


if __name__ == "__main__":
    success = test_web_search()
    sys.exit(0 if success else 1)
