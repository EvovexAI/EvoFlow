"""Remote MCP marketplace: Glama search + official Registry install resolution."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

GLAMA_API_BASE = "https://glama.ai/api/mcp/v1"
REGISTRY_API_BASE = "https://registry.modelcontextprotocol.io/v0.1"
HTTP_TIMEOUT = httpx.Timeout(20.0, connect=8.0)


def _ua_headers() -> dict[str, str]:
    return {"User-Agent": "EvoFlow-Gateway/1.0", "Accept": "application/json"}


def _glama_api_key() -> str:
    return (os.getenv("EVOFLOW_GLAMA_API_KEY") or os.getenv("GLAMA_API_KEY") or "").strip()


def _glama_headers() -> dict[str, str]:
    headers = _ua_headers()
    key = _glama_api_key()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _friendly_glama_error(exc: BaseException) -> str:
    text = str(exc)
    low = text.lower()
    if "401" in text or "unauthorized" in low:
        return (
            "Glama 目录需 API Key（https://glama.ai/settings/api-keys），"
            "已改用官方 MCP Registry + 精选列表。可设置 EVOFLOW_GLAMA_API_KEY。"
        )
    if "403" in text or "forbidden" in low:
        return "Glama 目录暂时不可用，已改用官方 MCP Registry + 精选列表。"
    if "timeout" in low or "timed out" in low:
        return "Glama 请求超时，已改用官方 MCP Registry + 精选列表。"
    return "Glama 暂时不可用，已改用官方 MCP Registry + 精选列表。"

# Curated fallback when Glama is unreachable or for featured list (kept in sync with evopanel HOT_MCP).
def _hot_meta(
    *,
    author: str = "modelcontextprotocol",
    transport: str = "stdio",
    auth: str = "无",
    verified: bool = True,
) -> dict[str, Any]:
    return {
        "author": author,
        "transport": transport,
        "auth": auth,
        "verified": verified,
        "source": "hot",
    }


HOT_MCP_SERVERS: list[dict[str, Any]] = [
    {
        "slug": "filesystem",
        "name": "Filesystem",
        "description": "读写本地文件系统，管理文件和目录操作",
        "install_cmd": "npx -y @modelcontextprotocol/server-filesystem",
        "stars": 9800,
        **_hot_meta(),
    },
    {
        "slug": "fetch",
        "name": "Web Fetch",
        "description": "抓取网页内容，获取互联网上的任意 URL 数据",
        "install_cmd": "npx -y @modelcontextprotocol/server-fetch",
        "stars": 8700,
        **_hot_meta(),
    },
    {
        "slug": "brave-search",
        "name": "Brave Search",
        "description": "使用 Brave Search 引擎进行实时网络搜索",
        "install_cmd": "npx -y @modelcontextprotocol/server-brave-search",
        "stars": 7500,
        **_hot_meta(auth="API Key"),
    },
    {
        "slug": "github",
        "name": "GitHub MCP Server",
        "description": "GitHub 仓库、Issue、PR、Actions 等全功能集成",
        "install_cmd": "npx -y @modelcontextprotocol/server-github",
        "stars": 7200,
        **_hot_meta(auth="Token"),
    },
    {
        "slug": "puppeteer",
        "name": "Puppeteer Browser",
        "description": "基于 Chromium 的浏览器自动化，支持截图、点击、表单填写",
        "install_cmd": "npx -y @anthropic/mcp-server-puppeteer",
        "stars": 6500,
        **_hot_meta(author="anthropic"),
    },
    {
        "slug": "memory",
        "name": "Memory Knowledge Graph",
        "description": "持久化记忆存储，基于知识图谱的上下文管理",
        "install_cmd": "npx -y @modelcontextprotocol/server-memory",
        "stars": 6100,
        **_hot_meta(),
    },
    {
        "slug": "postgres",
        "name": "PostgreSQL",
        "description": "PostgreSQL 数据库查询和管理，安全执行 SQL",
        "install_cmd": "npx -y @modelcontextprotocol/server-postgres",
        "stars": 5800,
        **_hot_meta(auth="连接串"),
    },
    {
        "slug": "slack",
        "name": "Slack",
        "description": "Slack 工作区消息收发、频道管理和用户信息获取",
        "install_cmd": "npx -y @modelcontextprotocol/server-slack",
        "stars": 5200,
        **_hot_meta(auth="Token"),
    },
    {
        "slug": "sequential-thinking",
        "name": "Sequential Thinking",
        "description": "逐步推理思维链，增强复杂问题解决能力",
        "install_cmd": "npx -y @modelcontextprotocol/server-sequentialthinking",
        "stars": 4900,
        **_hot_meta(),
    },
    {
        "slug": "notion",
        "name": "Notion",
        "description": "Notion 页面、数据库和块级内容读写管理",
        "install_cmd": "npx -y @mcp/notion-server",
        "stars": 4300,
        **_hot_meta(author="community", auth="Token", verified=False),
    },
]


def _hot_items(query: str = "") -> list[dict[str, Any]]:
    q = (query or "").strip().lower()
    items = HOT_MCP_SERVERS
    if q:
        items = [
            s
            for s in items
            if q in (s.get("slug") or "").lower()
            or q in (s.get("name") or "").lower()
            or q in (s.get("description") or "").lower()
        ]
    return [dict(s) for s in items]


def _hot_by_slug(slug: str | None) -> dict[str, Any] | None:
    key = (slug or "").strip().lower()
    if not key:
        return None
    for hot in HOT_MCP_SERVERS:
        if (hot.get("slug") or "").lower() == key:
            return hot
    return None


def _parse_github_repo(url: str) -> tuple[str, str] | None:
    match = re.match(r"https?://github\.com/([^/]+)/([^/#?]+)", (url or "").rstrip("/"))
    if not match:
        return None
    repo = match.group(2).removesuffix(".git")
    return match.group(1), repo


def _env_from_glama_schema(schema: dict[str, Any] | None) -> dict[str, str]:
    if not isinstance(schema, dict):
        return {}
    props = schema.get("properties") or {}
    if not isinstance(props, dict):
        return {}
    env: dict[str, str] = {}
    for name, spec in props.items():
        if not isinstance(spec, dict):
            continue
        key = str(name or "").strip()
        if not key:
            continue
        if spec.get("isSecret"):
            env[key] = f"${key}"
        elif spec.get("default") is not None:
            env[key] = str(spec.get("default"))
    return env


def _github_ts_entry(package: dict[str, Any]) -> str | None:
    bin_field = package.get("bin")
    if isinstance(bin_field, dict) and bin_field:
        entry = str(next(iter(bin_field.values())) or "").strip()
    elif isinstance(bin_field, str):
        entry = bin_field.strip()
    else:
        entry = ""
    if entry.startswith("dist/") and entry.endswith(".js"):
        return entry.replace("dist/", "src/").replace(".js", ".ts")
    if entry.endswith(".ts"):
        return entry
    return "src/index.ts"


async def _fetch_raw_text(url: str) -> str | None:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, headers={"User-Agent": "EvoFlow-Gateway/1.0"})
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.text


async def _fetch_github_package_json(owner: str, repo: str) -> dict[str, Any] | None:
    for branch in ("main", "master"):
        raw = await _fetch_raw_text(f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/package.json")
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return None


async def _config_from_github_repo(repo_url: str, *, description: str = "") -> dict[str, Any] | None:
    """Best-effort stdio config for Glama/GitHub-only MCP servers not in the official Registry."""
    parsed = _parse_github_repo(repo_url)
    if not parsed:
        return None
    owner, repo = parsed
    package = await _fetch_github_package_json(owner, repo)
    if not package:
        return None

    pkg_name = str(package.get("name") or repo).strip()
    if pkg_name and not package.get("private"):
        return _install_cmd_to_config(f"npx -y {pkg_name}", description=description)

    tsconfig = await _fetch_raw_text(f"https://raw.githubusercontent.com/{owner}/{repo}/main/tsconfig.json")
    if tsconfig is None:
        tsconfig = await _fetch_raw_text(f"https://raw.githubusercontent.com/{owner}/{repo}/master/tsconfig.json")
    if tsconfig:
        entry = _github_ts_entry(package)
        module_name = pkg_name or repo
        return {
            "type": "stdio",
            "command": "npx",
            "args": [
                "-y",
                "--package",
                "tsx",
                "--package",
                f"github:{owner}/{repo}",
                "tsx",
                f"node_modules/{module_name}/{entry}",
            ],
            "env": {},
            "enabled": True,
            "description": description or "",
        }

    return _install_cmd_to_config(f"npx -y github:{owner}/{repo}", description=description)


def _install_cmd_to_config(cmd: str, *, description: str = "") -> dict[str, Any]:
    parts = [p for p in (cmd or "").split() if p]
    cfg: dict[str, Any] = {"enabled": True, "description": description or ""}
    if not parts:
        return cfg
    if parts[0] == "npx":
        rest = parts[1:]
        pkg_probe = list(rest)
        while pkg_probe and pkg_probe[0] in ("-y", "--yes"):
            pkg_probe = pkg_probe[1:]
        if not pkg_probe:
            # Bare ``npx`` / ``npx -y`` cannot start an MCP server.
            return {
                "enabled": False,
                "type": "stdio",
                "command": "",
                "args": [],
                "description": (description or "invalid install_cmd: npx without package"),
            }
        cfg["type"] = "stdio"
        cfg["command"] = "npx"
        cfg["args"] = rest
    else:
        cfg["type"] = "stdio"
        cfg["command"] = parts[0]
        cfg["args"] = parts[1:]
    return cfg


def _glama_item(raw: dict[str, Any]) -> dict[str, Any]:
    ns = str(raw.get("namespace") or "").strip()
    slug = str(raw.get("slug") or raw.get("name") or "").strip()
    composite = f"{ns}/{slug}" if ns and slug else slug or ns
    repo = raw.get("repository") or {}
    repo_url = ""
    if isinstance(repo, dict):
        repo_url = str(repo.get("url") or "").strip()
    return {
        "slug": composite,
        "name": str(raw.get("name") or slug or composite),
        "title": str(raw.get("name") or slug or composite),
        "description": str(raw.get("description") or "").strip(),
        "author": ns,
        "url": str(raw.get("url") or "").strip(),
        "repository_url": repo_url,
        "glama_namespace": ns,
        "glama_slug": slug,
        "glama_id": str(raw.get("id") or "").strip(),
        "source": "glama",
        "install_cmd": "",
        "stars": 0,
    }


async def _fetch_glama_server_detail(namespace: str, slug: str) -> dict[str, Any] | None:
    ns = (namespace or "").strip()
    sl = (slug or "").strip()
    if not ns or not sl:
        return None
    url = f"{GLAMA_API_BASE}/servers/{quote(ns, safe='')}/{quote(sl, safe='')}"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, headers=_glama_headers())
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
    return data if isinstance(data, dict) else None


async def _fetch_glama(query: str, cursor: str | None, limit: int) -> tuple[list[dict[str, Any]], str | None, bool]:
    params: dict[str, str] = {"first": str(max(1, min(limit, 50)))}
    q = (query or "").strip()
    if q:
        params["query"] = q
    if cursor:
        params["after"] = cursor
    url = f"{GLAMA_API_BASE}/servers"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, params=params, headers=_glama_headers())
        resp.raise_for_status()
        data = resp.json()
    page = data.get("pageInfo") or {}
    servers = [_glama_item(s) for s in (data.get("servers") or []) if isinstance(s, dict)]
    next_cursor = page.get("endCursor") if page.get("hasNextPage") else None
    has_more = bool(page.get("hasNextPage"))
    return servers, next_cursor, has_more


def _registry_list_item(entry: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize official Registry list entry for Panel market cards."""
    if not isinstance(entry, dict):
        return None
    srv = entry.get("server") if isinstance(entry.get("server"), dict) else entry
    if not isinstance(srv, dict):
        return None
    full_name = str(srv.get("name") or "").strip()
    if not full_name:
        return None
    title = str(srv.get("title") or "").strip()
    slug = full_name.split("/")[-1] or full_name
    author = full_name.split("/")[0] if "/" in full_name else ""
    remotes = srv.get("remotes") or []
    packages = srv.get("packages") or []
    if remotes:
        transport = "http"
        auth = "可选"
    elif packages:
        transport = "stdio"
        auth = "可选"
    else:
        transport = "stdio"
        auth = "—"
    repo = srv.get("repository") if isinstance(srv.get("repository"), dict) else {}
    return {
        "slug": slug,
        "name": title or slug,
        "title": title or slug,
        "description": str(srv.get("description") or "").strip(),
        "author": author,
        "repository_url": str((repo or {}).get("url") or "").strip(),
        "registry_name": full_name,
        "glama_namespace": "",
        "glama_slug": "",
        "glama_id": "",
        "source": "registry",
        "verified": True,
        "stars": 0,
        "tool_count": None,
        "transport": transport,
        "auth": auth,
        "install_cmd": "",
    }


async def _fetch_registry_browse(
    query: str, cursor: str | None, limit: int
) -> tuple[list[dict[str, Any]], str | None, bool]:
    params: dict[str, str] = {
        "version": "latest",
        "limit": str(max(1, min(limit, 50))),
    }
    q = (query or "").strip()
    if q:
        params["search"] = q
    if cursor:
        params["cursor"] = cursor
    url = f"{REGISTRY_API_BASE}/servers"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, params=params, headers=_ua_headers())
        resp.raise_for_status()
        data = resp.json()
    meta = data.get("metadata") or {}
    items: list[dict[str, Any]] = []
    for raw in data.get("servers") or []:
        item = _registry_list_item(raw) if isinstance(raw, dict) else None
        if item:
            items.append(item)
    next_cursor = meta.get("nextCursor")
    has_more = bool(next_cursor)
    return items, next_cursor if has_more else None, has_more


def _merge_market_items(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    merged: list[dict[str, Any]] = []
    for group in groups:
        for item in group:
            key = (item.get("registry_name") or item.get("slug") or item.get("name") or "").lower()
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(item)
    return merged


async def search_mcp_market(*, query: str = "", cursor: str | None = None, limit: int = 20) -> dict[str, Any]:
    """Search marketplace: Glama (optional key) → official Registry → curated HOT."""
    q = (query or "").strip()
    # Entries from Glama vs Registry are incompatible — only continue the active source.
    cursor_src = ""
    real_cursor = cursor
    if cursor and ":" in str(cursor) and str(cursor).startswith("reg:"):
        cursor_src = "registry"
        real_cursor = str(cursor)[4:] or None
    elif cursor and str(cursor).startswith("gla:"):
        cursor_src = "glama"
        real_cursor = str(cursor)[4:] or None

    featured = _hot_items(q) if not real_cursor else []
    remote_items: list[dict[str, Any]] = []
    next_cursor: str | None = None
    has_more = False
    source = "hot"
    warning: str | None = None

    # Prefer Glama when an API key is configured (directory now requires auth).
    try_glama = cursor_src in ("", "glama")
    if try_glama and not _glama_api_key() and cursor_src != "glama":
        warning = (
            "未配置 Glama API Key，已使用官方 MCP Registry + 精选列表。"
            "需要 Glama 目录时设置 EVOFLOW_GLAMA_API_KEY。"
        )
        try_glama = False
    if try_glama:
        try:
            glama_items, glama_cursor, glama_more = await _fetch_glama(
                q, real_cursor if cursor_src in ("", "glama") else None, limit
            )
            if glama_items or glama_more:
                remote_items = glama_items
                next_cursor = f"gla:{glama_cursor}" if glama_cursor else None
                has_more = glama_more
                source = "glama"
                warning = None
        except Exception as exc:
            logger.warning("Glama MCP search failed: %s", exc)
            warning = _friendly_glama_error(exc)
            if cursor_src == "glama":
                # Cannot continue Glama pagination — fall through to registry first page.
                real_cursor = None

    # Official Registry when Glama missing / failed / or continuing registry cursor.
    if source != "glama" or cursor_src == "registry":
        try:
            reg_items, reg_cursor, reg_more = await _fetch_registry_browse(
                q, real_cursor if cursor_src == "registry" else None, limit
            )
            if reg_items or reg_more:
                remote_items = reg_items
                next_cursor = f"reg:{reg_cursor}" if reg_cursor else None
                has_more = reg_more
                source = "registry"
        except Exception as exc:
            logger.warning("Official MCP Registry browse failed: %s", exc)
            if not warning:
                warning = "在线目录暂时不可用，仅显示精选连接器。"

    merged = _merge_market_items(featured, remote_items)
    # First page: HOT + remote; pagination: remote page only.
    servers = remote_items if real_cursor else merged
    out: dict[str, Any] = {
        "servers": servers[: max(limit, 50)],
        "cursor": next_cursor,
        "has_more": has_more,
        "source": source if remote_items else "hot",
    }
    if warning and out["source"] != "glama":
        out["warning"] = warning
    return out


def _pick_package(packages: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not packages:
        return None
    npm = [p for p in packages if str(p.get("registryType") or "").lower() == "npm"]
    return npm[0] if npm else packages[0]


def _env_from_package(pkg: dict[str, Any]) -> dict[str, str]:
    env: dict[str, str] = {}
    for ev in pkg.get("environmentVariables") or []:
        if not isinstance(ev, dict):
            continue
        name = str(ev.get("name") or "").strip()
        if not name:
            continue
        if ev.get("isSecret"):
            env[name] = f"${name}"
        elif ev.get("default") is not None:
            env[name] = str(ev.get("default"))
    return env


def _stdio_from_package(pkg: dict[str, Any]) -> dict[str, Any]:
    hint = str(pkg.get("runtimeHint") or "").lower()
    identifier = str(pkg.get("identifier") or "").strip()
    args: list[str] = []
    for arg in pkg.get("runtimeArguments") or []:
        if isinstance(arg, dict) and arg.get("type") == "positional" and arg.get("value"):
            args.append(str(arg["value"]))
    command = "npx" if "npx" in hint or not hint else hint
    if command == "npx":
        if "-y" not in args:
            args = ["-y", *args]
        if identifier and identifier not in args:
            args.append(identifier)
    elif identifier:
        args = [identifier, *args]
    return {"type": "stdio", "command": command, "args": args, "env": _env_from_package(pkg)}


def _remote_from_server(server_obj: dict[str, Any]) -> dict[str, Any] | None:
    remotes = server_obj.get("remotes") or []
    if not remotes or not isinstance(remotes[0], dict):
        return None
    remote = remotes[0]
    rtype = str(remote.get("type") or "streamable-http").lower()
    transport = "http" if "http" in rtype else "sse"
    headers: dict[str, str] = {}
    for h in remote.get("headers") or []:
        if not isinstance(h, dict):
            continue
        hname = str(h.get("name") or "").strip()
        if not hname:
            continue
        val = str(h.get("value") or "")
        if h.get("isSecret") or "{" in val:
            # e.g. Bearer {smithery_api_key}
            m = re.search(r"\{([^}]+)\}", val)
            var = (m.group(1) if m else hname).upper()
            headers[hname] = f"${var}"
        else:
            headers[hname] = val
    cfg: dict[str, Any] = {
        "type": transport,
        "url": str(remote.get("url") or "").strip(),
        "headers": headers,
        "env": {},
    }
    return cfg if cfg.get("url") else None


def registry_server_to_mcp_config(server_payload: dict[str, Any]) -> dict[str, Any] | None:
    """Convert official Registry ``server`` JSON to EvoFlow ``extensions_config`` MCP entry."""
    server_obj = server_payload.get("server") if isinstance(server_payload.get("server"), dict) else server_payload
    if not isinstance(server_obj, dict):
        return None
    description = str(server_obj.get("description") or server_obj.get("title") or "").strip()
    pkg = _pick_package(server_obj.get("packages") or [])
    if pkg is not None:
        cfg = _stdio_from_package(pkg)
    else:
        cfg = _remote_from_server(server_obj)
    if not cfg:
        return None
    cfg["enabled"] = True
    cfg["description"] = description
    if not cfg.get("env"):
        cfg["env"] = {}
    return cfg


async def _fetch_registry_latest(registry_name: str) -> dict[str, Any] | None:
    encoded = quote(registry_name, safe="")
    url = f"{REGISTRY_API_BASE}/servers/{encoded}/versions/latest"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, headers=_ua_headers())
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()


async def _search_registry_by_keyword(keyword: str, *, repo_url: str = "") -> dict[str, Any] | None:
    if not keyword.strip():
        return None
    params = {"search": keyword.strip(), "version": "latest", "limit": "10"}
    url = f"{REGISTRY_API_BASE}/servers"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, params=params, headers=_ua_headers())
        resp.raise_for_status()
        data = resp.json()
    servers = data.get("servers") or []
    if not servers:
        return None
    if repo_url:
        repo_norm = repo_url.rstrip("/").lower()
        for entry in servers:
            srv = (entry or {}).get("server") or entry
            rurl = ((srv.get("repository") or {}).get("url") or "").rstrip("/").lower()
            if rurl and rurl == repo_norm:
                return entry
        return None
    return servers[0]


async def resolve_mcp_install_config(
    *,
    registry_name: str | None = None,
    glama_namespace: str | None = None,
    glama_slug: str | None = None,
    slug: str | None = None,
    repository_url: str | None = None,
) -> dict[str, Any]:
    """Resolve installable MCP config for EvoPanel one-click add."""
    name_hint = ""
    config: dict[str, Any] | None = None
    resolved_registry = (registry_name or "").strip()

    if not resolved_registry and (glama_namespace or glama_slug):
        resolved_registry = await _guess_registry_from_glama(glama_namespace, glama_slug, repository_url)

    if resolved_registry:
        payload = await _fetch_registry_latest(resolved_registry)
        if payload:
            config = registry_server_to_mcp_config(payload)
            name_hint = resolved_registry.split("/")[-1] or resolved_registry

    # Curated hot list wins over fuzzy Registry keyword search (e.g. slug "github").
    if config is None and slug and not glama_namespace and not glama_slug:
        hot = _hot_by_slug(slug)
        if hot:
            config = _install_cmd_to_config(hot.get("install_cmd") or "", description=hot.get("description") or "")
            name_hint = hot.get("name") or slug

    if config is None and (glama_slug or slug):
        keyword = (glama_slug or slug or "").strip()
        try:
            entry = await _search_registry_by_keyword(keyword, repo_url=repository_url or "")
        except Exception as exc:
            logger.warning("Registry keyword search failed for %r: %s", keyword, exc)
            entry = None
        if entry:
            config = registry_server_to_mcp_config(entry)
            srv = entry.get("server") or entry
            name_hint = str(srv.get("name") or keyword).split("/")[-1]

    if config is None and slug:
        hot = _hot_by_slug(slug)
        if hot:
            config = _install_cmd_to_config(hot.get("install_cmd") or "", description=hot.get("description") or "")
            name_hint = hot.get("name") or slug

    if config is None and (glama_namespace or glama_slug):
        detail: dict[str, Any] | None = None
        try:
            detail = await _fetch_glama_server_detail(glama_namespace or "", glama_slug or slug or "")
        except Exception as exc:
            logger.warning("Glama detail fetch failed for %s/%s: %s", glama_namespace, glama_slug, exc)
        if detail:
            repo = detail.get("repository") or {}
            repo_url = str((repo.get("url") if isinstance(repo, dict) else "") or repository_url or "").strip()
            desc = str(detail.get("description") or "").strip()
            env = _env_from_glama_schema(detail.get("environmentVariablesJsonSchema"))
            if repo_url:
                try:
                    gh_cfg = await _config_from_github_repo(repo_url, description=desc)
                except Exception as exc:
                    logger.warning("GitHub install inference failed for %s: %s", repo_url, exc)
                    gh_cfg = None
                if gh_cfg:
                    gh_cfg["env"] = {**env, **(gh_cfg.get("env") or {})}
                    config = gh_cfg
                    name_hint = str(detail.get("name") or glama_slug or slug or name_hint)

    if config is None:
        raise ValueError(
            "Could not resolve install configuration from Registry or Glama. "
            "Add manually or provide registry_name."
        )

    display_name = name_hint or (glama_slug or slug or resolved_registry or "mcp-server")
    return {"name": display_name, "config": config, "registry_name": resolved_registry or None}


async def _guess_registry_from_glama(
    namespace: str | None,
    slug: str | None,
    repository_url: str | None,
) -> str:
    """Best-effort: map Glama entry to official registry server name via repo URL or slug search."""
    if repository_url:
        try:
            entry = await _search_registry_by_keyword(slug or namespace or "", repo_url=repository_url)
        except Exception as exc:
            logger.warning("Registry lookup failed for Glama repo %s: %s", repository_url, exc)
            entry = None
        if entry:
            srv = entry.get("server") or entry
            return str(srv.get("name") or "")
    if slug:
        try:
            entry = await _search_registry_by_keyword(slug, repo_url=repository_url or "")
        except Exception as exc:
            logger.warning("Registry lookup failed for Glama slug %r: %s", slug, exc)
            entry = None
        if entry:
            srv = entry.get("server") or entry
            return str(srv.get("name") or "")
    return ""
