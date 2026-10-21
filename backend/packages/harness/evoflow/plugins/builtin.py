"""Builtin official marketplace seeding.

The store lists only plugins shipped with EvoFlow:

1. **Packaged bundle** — ``EVOFLOW_BUNDLED_PLUGINS_ROOT``,
   ``evoflow/plugins/bundled_official``, or the gateway sidecar
   ``official-plugins-bundle``. Each ``<name>/<version>/`` directory becomes a
   filesystem marketplace entry.
2. **Shipped demos** — ``evoflow-guide`` / ``hello-command`` / ``evoflow-skill-kit``.

No external plugin cache or remote catalog is consulted.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

from .manifest import EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE
from .storage import load_installed_plugins_state, save_installed_plugins_state

logger = logging.getLogger(__name__)

BUILTIN_DIR = Path(__file__).parent / "builtin"

SEED_MANIFEST_VERSION = 15  # v15: reseed after stub-bundle releases so real packaged plugins appear

# 面向用户展示的 listing 文案统一使用 EvoFlow 品牌（这是 EvoFlow 平台的市场）。
# 仅替换文本字段；插件 name slug、icon URL 等标识保持原样。
_LISTING_TEXT_FIELDS = ("displayName", "description")
_LISTING_I18N_FIELDS = ("displayName_i18n", "description_i18n", "examplePrompts_i18n")
_LISTING_LIST_FIELDS = ("examplePrompts",)


def _rebrand_listing_text(value: str) -> str:
    return value.replace("ZCode", "EvoFlow").replace("zcode", "evoflow")


def _rebrand_entry_text(entry: dict[str, Any]) -> None:
    for field in _LISTING_TEXT_FIELDS:
        value = entry.get(field)
        if isinstance(value, str) and "zcode" in value.lower():
            entry[field] = _rebrand_listing_text(value)
    for field in _LISTING_I18N_FIELDS:
        i18n = entry.get(field)
        if isinstance(i18n, dict):
            for locale, text in list(i18n.items()):
                if isinstance(text, str) and "zcode" in text.lower():
                    i18n[locale] = _rebrand_listing_text(text)
        elif isinstance(i18n, list):
            entry[field] = [
                _rebrand_listing_text(text) if isinstance(text, str) and "zcode" in text.lower() else text
                for text in i18n
            ]
    for field in _LISTING_LIST_FIELDS:
        values = entry.get(field)
        if isinstance(values, list):
            entry[field] = [
                _rebrand_listing_text(text) if isinstance(text, str) and "zcode" in text.lower() else text
                for text in values
            ]
    author = entry.get("author")
    if isinstance(author, dict):
        name = author.get("name")
        if isinstance(name, str) and "zcode" in name.lower():
            author["name"] = _rebrand_listing_text(name)


# Host / helper runtimes and legacy guide slugs — not shown in the store.
EXCLUDED_OFFICIAL_PLUGINS = {"node-repl-host", "cua-helper", "zcode-guide"}

# Auto-installed + enabled when packaged files resolve.
DEFAULT_ENABLED_OFFICIAL_PLUGINS = {
    "browser-use",
    "computer-use",
    "documents",
    "pdf",
    "presentations",
    "spreadsheets",
    "image-search",
    "plugin-creator",
    "skill-creator",
    "evoflow-guide",
}

# Core product plugins expected under packaging/official-plugins-bundle.
BUNDLED_OFFICIAL_PLUGIN_NAMES = (
    "browser-use",
    "computer-use",
    "documents",
    "pdf",
    "presentations",
    "spreadsheets",
    "image-search",
    "plugin-creator",
    "skill-creator",
    "node-repl-host",
)


def builtin_plugin_dir(name: str) -> Path:
    return BUILTIN_DIR / "plugins" / name


def _path_nonempty_dir(path: Path) -> bool:
    """True when ``path`` has at least one plugin subdirectory (ignore lone .gitignore)."""
    try:
        if not path.is_dir():
            return False
        return any(child.is_dir() for child in path.iterdir())
    except OSError:
        return False


def _bundled_official_cache_candidates() -> list[Path]:
    """Installer / PyInstaller / dev packaging locations for official plugins."""
    candidates: list[Path] = []
    override = os.getenv("EVOFLOW_BUNDLED_PLUGINS_ROOT", "").strip()
    if override:
        candidates.append(Path(override))
    # In-package path (PyInstaller datas → evoflow/plugins/bundled_official).
    candidates.append(Path(__file__).resolve().parent / "bundled_official")
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "evoflow" / "plugins" / "bundled_official")
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        # Current installers ship plugins only under _internal/.../bundled_official
        # (via PyInstaller datas). Keep exe-dir fallbacks for older sidecars.
        candidates.append(exe_dir / "official-plugins-bundle")
        candidates.append(exe_dir / "bundled_official")
    # Dev tree: backend/packaging/official-plugins-bundle
    try:
        backend_root = Path(__file__).resolve().parents[4]
        candidates.append(backend_root / "packaging" / "official-plugins-bundle")
    except IndexError:
        pass
    return candidates


def discover_bundled_official_cache() -> Path | None:
    """Official plugins shipped with the EvoFlow installer / packaging tree."""
    for candidate in _bundled_official_cache_candidates():
        if _path_nonempty_dir(candidate):
            return candidate
    return None


def discover_official_plugin_cache() -> Path | None:
    """Plugins shipped inside this EvoFlow build."""
    return discover_bundled_official_cache()


def _load_json_object(path: Path) -> dict[str, Any] | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = raw.decode("utf-16")
    else:
        text = raw.decode("utf-8")
    try:
        payload = json.loads(text)
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _load_bundled_marketplace_manifest(cache_root: Path | None) -> dict[str, Any] | None:
    if cache_root is None:
        return None
    for path in (
        cache_root / "marketplace.json",
        cache_root.parent / "marketplace.json",
    ):
        payload = _load_json_object(path)
        if payload is not None and isinstance(payload.get("plugins"), list):
            return payload
    return None


def _latest_cache_version_dir(cache_root: Path, plugin_name: str) -> Path | None:
    plugin_dir = cache_root / plugin_name
    if not plugin_dir.is_dir():
        return None
    version_dirs = sorted(
        (d for d in plugin_dir.iterdir() if d.is_dir()),
        key=lambda d: [int(part) if part.isdigit() else 0 for part in d.name.split(".")],
    )
    return version_dirs[-1] if version_dirs else None


def _resolve_cache_version(cache_roots: list[Path], plugin_name: str) -> Path | None:
    for root in cache_roots:
        resolved = _latest_cache_version_dir(root, plugin_name)
        if resolved is not None:
            return resolved
    return None


def _demo_marketplace_manifest() -> dict[str, Any]:
    """Dev-tree demos only when their source dirs exist (not packed into installers)."""
    candidates: list[dict[str, Any]] = [
        {
            "name": "evoflow-guide",
            "displayName": "EvoFlow Guide",
            "displayName_i18n": {"zh-CN": "EvoFlow 使用与诊断指南"},
            "description": (
                "EvoFlow usage and self-diagnosis guide: teaches agents and users how to "
                "configure MCP servers, commands, skills, hooks, and plugins, and how to "
                "locate and fix configuration problems for each."
            ),
            "version": "1.0.0",
            "category": "guides",
            "tags": ["guide", "diagnostics", "configuration"],
            "author": {"name": "EvoFlow"},
            "source": "filesystem",
            "cachePath": str(builtin_plugin_dir("evoflow-guide")),
            "icon": "/api/plugins/icon/evoflow-guide",
        },
        {
            "name": "hello-command",
            "displayName": "Hello Command",
            "displayName_i18n": {"zh-CN": "Hello 命令示例"},
            "description": "Demo slash-command plugin shipped with EvoFlow.",
            "version": "1.0.0",
            "category": "demos",
            "author": {"name": "EvoFlow"},
            "source": "filesystem",
            "cachePath": str(builtin_plugin_dir("hello-command")),
            "icon": "/api/plugins/icon/hello-command",
        },
        {
            "name": "evoflow-skill-kit",
            "displayName": "EvoFlow Skill Kit",
            "displayName_i18n": {"zh-CN": "EvoFlow 技能示例包"},
            "description": "Demo skill plugin shipped with EvoFlow.",
            "version": "1.0.0",
            "category": "demos",
            "author": {"name": "EvoFlow"},
            "source": "filesystem",
            "cachePath": str(builtin_plugin_dir("evoflow-skill-kit")),
            "icon": "/api/plugins/icon/evoflow-skill-kit",
        },
    ]
    plugins = [
        entry
        for entry in candidates
        if Path(str(entry["cachePath"])).is_dir()
    ]
    return {
        "name": EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE,
        "description": "EvoFlow 官方插件市场（内置示例，离线可用）。",
        "plugins": plugins,
    }


def _entry_from_listing(raw: dict[str, Any], cache_roots: list[Path]) -> dict[str, Any] | None:
    """Keep a bundled listing row only when the plugin files are in the package."""
    name = str(raw.get("name") or "").strip()
    if not name or name in EXCLUDED_OFFICIAL_PLUGINS:
        return None
    resolved = _resolve_cache_version(cache_roots, name)
    if resolved is None:
        return None
    entry = dict(raw)
    _rebrand_entry_text(entry)
    entry["source"] = "filesystem"
    entry["cachePath"] = str(resolved)
    if not entry.get("version"):
        entry["version"] = resolved.name
    return entry


def _synthesize_filesystem_entries(
    cache_roots: list[Path],
    listing_by_name: dict[str, dict[str, Any]],
    seen: set[str],
) -> list[dict[str, Any]]:
    """Expose every packaged ``<name>/<version>/`` directory."""
    out: list[dict[str, Any]] = []
    for root in cache_roots:
        try:
            children = list(root.iterdir())
        except OSError:
            continue
        for child in children:
            if not child.is_dir():
                continue
            name = child.name
            if name in seen or name in EXCLUDED_OFFICIAL_PLUGINS:
                continue
            if name in {"marketplace.json"}:
                continue
            resolved = _latest_cache_version_dir(root, name)
            if resolved is None:
                continue
            raw = dict(listing_by_name.get(name) or {"name": name})
            raw.setdefault("version", resolved.name)
            raw.setdefault("displayName", name)
            raw["source"] = "filesystem"
            raw["cachePath"] = str(resolved)
            _rebrand_entry_text(raw)
            seen.add(name)
            out.append(raw)
    return out


def build_official_marketplace_manifest() -> dict[str, Any]:
    """Compose the official marketplace manifest for seed / store UI."""
    plugins: list[dict[str, Any]] = []
    seen: set[str] = set()

    cache_roots: list[Path] = []
    bundled = discover_bundled_official_cache()
    if bundled is not None:
        cache_roots.append(bundled)

    listing = _load_bundled_marketplace_manifest(bundled)
    listing_by_name: dict[str, dict[str, Any]] = {}
    if listing:
        for raw in listing.get("plugins", []):
            if not isinstance(raw, dict):
                continue
            name = str(raw.get("name") or "").strip()
            if name:
                listing_by_name[name] = raw

    if listing:
        for raw in listing.get("plugins", []):
            if not isinstance(raw, dict):
                continue
            entry = _entry_from_listing(raw, cache_roots)
            if entry is None:
                continue
            name = str(entry.get("name") or "")
            if not name or name in seen:
                continue
            seen.add(name)
            plugins.append(entry)

    plugins.extend(_synthesize_filesystem_entries(cache_roots, listing_by_name, seen))

    for demo in _demo_marketplace_manifest()["plugins"]:
        if demo["name"] in seen:
            continue
        seen.add(demo["name"])
        plugins.append(demo)

    if not plugins:
        return _demo_marketplace_manifest()

    if cache_roots:
        description = "EvoFlow 官方插件市场（安装包内置插件）。"
    else:
        description = "EvoFlow 官方插件市场（内置示例）。"

    return {
        "name": EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE,
        "description": description,
        "plugins": plugins,
    }


def _cleanup_excluded_installed_plugins(storage_root: Path) -> None:
    """Remove any installed plugins whose name is in EXCLUDED_OFFICIAL_PLUGINS."""
    state = load_installed_plugins_state(storage_root)
    original_count = len(state.plugins)
    state.plugins = [p for p in state.plugins if p.name not in EXCLUDED_OFFICIAL_PLUGINS]
    for pid in list(state.enabled_plugins):
        name = pid.split("@", 1)[0]
        if name in EXCLUDED_OFFICIAL_PLUGINS:
            del state.enabled_plugins[pid]
    if len(state.plugins) != original_count:
        save_installed_plugins_state(storage_root, state)
        logger.info("Cleaned up %d excluded installed plugin(s).", original_count - len(state.plugins))


def seed_official_marketplace(storage_root: Path) -> dict[str, Any]:
    """Ensure the official marketplace manifest cache exists and default-enabled
    plugins are installed; returns the raw manifest."""
    from .storage import load_marketplace_manifest_cached, save_marketplace_manifest_cache

    existing = load_marketplace_manifest_cached(storage_root, EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE)
    existing_plugins = existing.raw.get("plugins") if existing is not None else None
    if (
        existing is not None
        and existing.raw.get("__seededVersion") == SEED_MANIFEST_VERSION
        and isinstance(existing_plugins, list)
        and existing_plugins
    ):
        _cleanup_excluded_installed_plugins(storage_root)
        return existing.raw
    manifest = build_official_marketplace_manifest()
    manifest["__seededVersion"] = SEED_MANIFEST_VERSION
    _localize_official_icons(storage_root, manifest)
    _seed_local_plugin_icons(storage_root, manifest)
    save_marketplace_manifest_cache(storage_root, manifest)
    _install_default_enabled_plugins(storage_root, manifest)
    _cleanup_excluded_installed_plugins(storage_root)
    return manifest


ICON_MAX_BYTES = 2 * 1024 * 1024
ICON_DOWNLOAD_TIMEOUT_SEC = 10


def icons_dir(storage_root: Path) -> Path:
    return storage_root / "icons"


def _localize_official_icons(storage_root: Path, manifest: dict[str, Any]) -> None:
    """Download official CDN icons once into ``<storage>/icons`` and rewrite the
    manifest icon fields to the local ``/api/plugins/icon/<name>`` endpoint, so
    the store shows real plugin icons without a browser-side CDN round trip."""
    import httpx

    target_dir = icons_dir(storage_root)
    for entry in manifest.get("plugins", []):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        icon_url = str(entry.get("icon") or "").strip()
        if not name or not icon_url.startswith(("http://", "https://")):
            continue
        suffix = Path(icon_url.split("?", 1)[0]).suffix.lower() or ".png"
        if suffix not in (".png", ".jpg", ".jpeg", ".svg", ".webp"):
            suffix = ".png"
        local_path = target_dir / f"{name}{suffix}"
        if not local_path.is_file():
            try:
                with httpx.Client(follow_redirects=True, timeout=ICON_DOWNLOAD_TIMEOUT_SEC) as client:
                    response = client.get(icon_url)
                if response.status_code != 200 or len(response.content) > ICON_MAX_BYTES:
                    logger.info(
                        "Icon download skipped for %s (status=%s size=%s)",
                        name,
                        response.status_code,
                        len(response.content),
                    )
                    continue
                target_dir.mkdir(parents=True, exist_ok=True)
                local_path.write_bytes(response.content)
            except Exception as error:  # noqa: BLE001 - icon is cosmetic
                logger.info("Icon download failed for %s: %s", name, error)
                continue
        entry["icon"] = f"/api/plugins/icon/{name}"


_ICON_SUFFIXES = (".png", ".jpg", ".jpeg", ".svg", ".webp")


def local_plugin_icon_api_path(storage_root: Path, name: str) -> str | None:
    """API path when ``<storage>/icons/<name>.<ext>`` already exists on disk."""
    safe = str(name or "").strip()
    if not safe or _find_icon_file(icons_dir(storage_root), safe) is None:
        return None
    return f"/api/plugins/icon/{safe}"


def _find_icon_file(directory: Path, name: str) -> Path | None:
    if not directory.is_dir():
        return None
    for suffix in _ICON_SUFFIXES:
        candidate = directory / f"{name}{suffix}"
        if candidate.is_file():
            return candidate
    return None


def _seed_local_plugin_icons(storage_root: Path, manifest: dict[str, Any]) -> None:
    """Populate ``<storage>/icons`` and rewrite listing ``icon`` to local API paths.

    Sources (in order): packaged ``official-plugins-bundle/icons``,
    ``cachePath/icon.png``, then any icon already present under storage.
    """
    target_dir = icons_dir(storage_root)
    bundled = discover_bundled_official_cache()
    bundled_icons = (bundled / "icons") if bundled is not None else None

    for entry in manifest.get("plugins", []):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue

        # 1) Packaged installer icons (offline).
        if bundled_icons is not None:
            packaged = _find_icon_file(bundled_icons, name)
            if packaged is not None:
                dest = target_dir / packaged.name
                if not dest.is_file():
                    try:
                        target_dir.mkdir(parents=True, exist_ok=True)
                        dest.write_bytes(packaged.read_bytes())
                    except OSError as error:
                        logger.info("Packaged icon copy failed for %s: %s", name, error)
                if dest.is_file() or packaged.is_file():
                    entry["icon"] = f"/api/plugins/icon/{name}"
                    continue

        # 2) Per-plugin icon.png next to the plugin root (demos / filesystem).
        cache_path = entry.get("cachePath")
        if cache_path:
            builtin_icon = Path(str(cache_path)) / "icon.png"
            if builtin_icon.is_file():
                dest = target_dir / f"{name}.png"
                if not dest.is_file():
                    try:
                        target_dir.mkdir(parents=True, exist_ok=True)
                        dest.write_bytes(builtin_icon.read_bytes())
                    except OSError as error:
                        logger.info("Builtin icon copy failed for %s: %s", name, error)
                if dest.is_file() or builtin_icon.is_file():
                    entry["icon"] = f"/api/plugins/icon/{name}"
                    continue

        # 3) Already cached from a prior CDN download — still wire the API path.
        if _find_icon_file(target_dir, name) is not None:
            entry["icon"] = f"/api/plugins/icon/{name}"


# Back-compat alias for tests / callers that still monkeypatch the old name.
_seed_builtin_plugin_icons = _seed_local_plugin_icons


def _install_default_enabled_plugins(storage_root: Path, manifest: dict[str, Any]) -> None:
    """Auto-install + enable default-enabled official plugins when resolvable."""
    from datetime import datetime, timezone

    from .manifest import parse_marketplace_manifest, resolve_installed_plugin_version
    from .sources import PluginSourceError, resolve_plugin_source_root
    from .storage import (
        InstalledPluginRecord,
        copytree_atomic,
        ensure_plugin_data_dir,
        marketplace_manifest_path,
        plugin_cache_dir,
        save_installed_plugins_state,
    )

    try:
        parsed = parse_marketplace_manifest(manifest, "builtin-seed")
        state = load_installed_plugins_state(storage_root)
        marketplace_dir = marketplace_manifest_path(storage_root, parsed.name).parent
        changed = False
        for entry in parsed.plugins:
            if entry.name not in DEFAULT_ENABLED_OFFICIAL_PLUGINS:
                continue
            plugin_id = f"{entry.name}@{parsed.name}"
            if any(record.id == plugin_id for record in state.plugins):
                continue
            try:
                resolved = resolve_plugin_source_root(entry, parsed, marketplace_dir, storage_root)
            except (PluginSourceError, Exception) as error:  # noqa: BLE001 - seed must not fail wholesale
                logger.warning("Seed default plugin %s failed: %s", plugin_id, error)
                continue
            try:
                version = resolve_installed_plugin_version(resolved.path, entry.version)
                target = plugin_cache_dir(storage_root, parsed.name, entry.name, version)
                if resolved.path.resolve() != target.resolve():
                    copytree_atomic(resolved.path, target)
                state.plugins.append(
                    InstalledPluginRecord(
                        id=plugin_id,
                        name=entry.name,
                        marketplace=parsed.name,
                        version=version,
                        installPath=str(target),
                        installedAt=datetime.now(timezone.utc).isoformat(),
                        scope="user",
                        source=entry.source,
                    )
                )
                state.enabled_plugins[plugin_id] = True
                ensure_plugin_data_dir(storage_root, plugin_id)
                changed = True
            finally:
                if resolved.cleanup:
                    try:
                        resolved.cleanup()
                    except Exception:  # noqa: BLE001
                        pass
        if changed:
            save_installed_plugins_state(storage_root, state)
            logger.info(
                "Seeded default-enabled official plugins: %s",
                sorted(DEFAULT_ENABLED_OFFICIAL_PLUGINS),
            )
    except Exception:  # noqa: BLE001 - seeding must never break startup
        logger.warning("Default plugin seeding failed", exc_info=True)
