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

format:
	uv run ruff check . --fix && uv run ruff format .
