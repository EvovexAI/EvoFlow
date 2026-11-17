"""已知向量模型 → 维度 的静态映射（**轻量叶子模块，禁止引入任何重型依赖**）。

【self-evolution-bot · 2026-11-17 · 第33轮】从 ``registry.py`` 拆出来。
为什么：``registry.py`` 在模块级 import 了 ``base``（-> transformers/numpy/PIL）
和 ``local_provider``，实测首次 import **2426 个模块 / 1063 个重型依赖 / 4340ms**。
而 ``known_embedding_dim()`` 只是查一张字典表，却被 ``code_index.store._resolved_embedding_dim``
在**每次检索**的路径上调用（``_ensure_schema -> _ensure_vec_table -> _resolved_embedding_dim``），
于是「打开索引库」这一步被拖到 3~4 秒，用户感知就是 read 类检索工具莫名其妙很慢。

本模块只允许 import 标准库，保持叶子地位；``registry.known_embedding_dim`` 与
``_KNOWN_DIMS`` 仍从 registry re-export，既有调用方无需改动。
"""

from __future__ import annotations

_KNOWN_DIMS: dict[str, int] = {
    # Cloud (OpenAI-compatible)
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
    # 【self-evolution-bot · 2026-11-16 · 第24轮】补上当前实际生效的云端向量模型。
    # 为什么：本机 get_embedding_config() 解析到的就是 doubao-embedding-vision，
    # 实测输出 2048 维（真调用量得）；此前不在表里 → 调用方退回配置静态 512 →
    # code_vec 按 512 建表 → 每条向量插入被 vec0 拒绝（Expected 512 received 2048）→ 表里 0 行。
    "doubao-embedding-vision": 2048,
    # Local (sentence-transformers / BGE)
    "baai/bge-small-zh-v1.5": 512,
    "baai/bge-base-zh-v1.5": 768,
    "baai/bge-large-zh-v1.5": 1024,
    "baai/bge-m3": 1024,
    "baai/bge-small-en-v1.5": 384,
    "bge-small-zh-v1.5": 512,
    "bge-base-zh-v1.5": 768,
    "bge-large-zh-v1.5": 1024,
    "bge-m3": 1024,
    "bge-small-en-v1.5": 384,
    "sentence-transformers/all-minilm-l6-v2": 384,
    "sentence-transformers/paraphrase-multilingual-minilm-l12-v2": 384,
    "intfloat/multilingual-e5-small": 384,
    "thenlper/gte-small": 384,
    "shibing624/text2vec-base-chinese": 768,
    "nomic-ai/nomic-embed-text-v1.5": 768,
}


def known_embedding_dim(model_id: str) -> int | None:
    """Return the vector dimension for a known model id, or ``None`` if unknown.

    Lookups are case-insensitive so ``BAAI/bge-small-zh-v1.5`` and
    ``baai/bge-small-zh-v1.5`` both match.
    """
    if not model_id:
        return None
    key = model_id.strip().lower()
    return _KNOWN_DIMS.get(key)
