"""EvoFlow admin services — config/persistence operations without tools coupling."""

# 修复依据：此前本包 __init__ 模块级全量 import 13 个 admin 子模块，导致仅 import
# evoflow.admin.errors（如 evoflow/cli/common.py）也会经 admin.agents →
# persistence.config_repositories → models.factory 拉起 langchain → torch →
# transformers（实测 importtime：torch ≈0.92s、transformers ≈0.67s），CLI 仅解析
# argparse 即付出 ~2.7s。子模块改为按需加载：`from evoflow.admin import X` 与
# `from evoflow.admin import *`（按 __all__）均由 Python 自动 import 对应子模块，
# 语义不变。
from evoflow.admin.errors import AdminError, ConflictError, ForbiddenError, NotFoundError, ValidationError

__all__ = [
    "AdminError",
    "ConflictError",
    "ForbiddenError",
    "NotFoundError",
    "ValidationError",
    "agents",
    "apps",
    "automation",
    "employees",
    "experience",
    "knowledge",
    "mcp",
    "memory",
    "models",
    "platform_actions",
    "profile",
    "sessions",
    "skills",
]
