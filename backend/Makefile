install:
	uv sync

dev:
	uv run langgraph dev --no-browser --allow-blocking --no-reload --server-log-level INFO

gateway:
	PYTHONPATH=. uv run uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001

test:
	PYTHONPATH=. uv run pytest app/tests packages/harness/tests tests/ -v

lint:
	uv run ruff check .
	uv run ruff format --check .

# Fatal-only gate: names used without an assignment/binding (ruff F821).
#
# The full `lint` target above is a backlog number (388 findings at the time of
# writing) and runs only on manual `workflow_dispatch`, so it never actually
# blocked anything. That is how b20b2f66 shipped `source_canon=source_canon`
# read before its own assignment and took down every task-create path with
# UnboundLocalError for a day. F821 is different in kind from the rest of the
# backlog: it is *always* a crash (NameError/UnboundLocalError) on the code path
# that touches it, never a style nit. Keep this target at zero and wire it into
# the cheap pre-commit lane — a new F821 must fail the commit.
lint-fatal:
	uv run ruff check --select F821 .

# Retrieval recall baseline: one command, prints hit@1, red below baseline.
# 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
# Why this exists: the 60-query frozen pool + evaluator used to live only in
# .gitignore'd outputs/, so "is search still accurate?" had no answer nobody
# could reproduce — I once reported a fake 55/59 and nearly reverted a correct
# fix. Pool now lives in tests/fixtures/code_index_recall_pool.json.
# Skips (not passes) on a clean checkout with no .evoflow/code_index/index.db.
recall:
	PYTHONPATH=packages/harness:. uv run pytest tests/test_code_index_recall_baseline.py -q -s

format:
	uv run ruff check . --fix && uv run ruff format .
