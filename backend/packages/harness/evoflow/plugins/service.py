"""Plugin management service — the EvoFlow port of ZCode's plugin management.

Implements the same operation set as the ZCode CLI plugin adapters
(marketplace add/remove/refresh, install with dependency closure,
uninstall/update/restore, per-plugin enable state, describe/validate,
component enumeration) and projects results into the exact wire shapes the
vendored ZCode settings UI consumes (``ZCodePluginsOverviewResult`` and
friends from ``zcode-protocol``).
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .builtin import (
    EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE,
    EXCLUDED_OFFICIAL_PLUGINS,
    local_plugin_icon_api_path,
    seed_official_marketplace,
)
from .components import component_types_from_groups, enumerate_plugin_components
from .manifest import (
    DEFAULT_VERSION,
    PluginDiagnostic,
    PluginManifestError,
    MarketplaceEntry,
    MarketplaceManifest,
    read_plugin_manifest_from_root,
    resolve_installed_plugin_version,
    validate_plugin_name,
)
from .sources import (
    PluginSourceError,
    parse_marketplace_source_input,
    resolve_marketplace_source_root,
    resolve_plugin_source_root,
    validate_marketplace_source_only,
)
from .storage import (
    InstalledPluginRecord,
    InstalledPluginsState,
    KnownMarketplaceRecord,
    copytree_atomic,
    ensure_plugin_data_dir,
    load_installed_plugins_state,
    load_known_marketplaces,
    load_marketplace_manifest_cached,
    marketplace_manifest_path,
    plugin_data_dir,
    resolve_installed_plugin_root,
    resolve_storage_root,
    save_installed_plugins_state,
    save_known_marketplaces,
    save_marketplace_manifest_cache,
    sanitize_plugin_id,
    upsert_known_marketplace,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ulog(message: str) -> None:
    """统一浏览器/插件调试日志（logs/plugin-control.log，三端汇聚）。"""
    try:
        from evoflow.tools.builtins.browser_debug_log import browser_debug_log

        browser_debug_log("py", f"[plugin-service] {message}")
    except Exception:
        pass


def _diagnostic_to_json(diagnostic: PluginDiagnostic) -> dict[str, Any]:
    return diagnostic.to_json()


def _listing_with_local_icon(
    storage_root: Path, name: str, listing: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Point the picker at ``/api/plugins/icon/<name>`` when a png is already on disk.

    Installed builds can have an empty marketplace listing (bundle not discovered)
    while ``<storage>/icons`` still holds the files from an earlier seed.
    """
    icon = str((listing or {}).get("icon") or "").strip()
    if icon.startswith(("/api/plugins/icon/", "http://", "https://")):
        return listing
    local = local_plugin_icon_api_path(storage_root, name)
    if not local:
        return listing
    merged = dict(listing or {})
    merged["icon"] = local
    return merged


class PluginManagementService:
    """Stateful plugin manager bound to a storage root."""

    def __init__(self, storage_root: Path | None = None) -> None:
        self.storage_root = Path(storage_root) if storage_root else resolve_storage_root()

    # ------------------------------------------------------------------
    # Marketplace operations
    # ------------------------------------------------------------------

    def ensure_default_marketplaces(self) -> list[KnownMarketplaceRecord]:
        manifest_raw = seed_official_marketplace(self.storage_root)
        official_count = len(manifest_raw.get("plugins") or [])
        known = load_known_marketplaces(self.storage_root)
        if not any(record.id == EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE for record in known):
            now = _now()
            known.append(
                KnownMarketplaceRecord(
                    id=EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE,
                    source={"source": "settings"},
                    name=EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE,
                    description=str(manifest_raw.get("description") or "EvoFlow 官方插件市场"),
                    addedAt=now,
                    lastUpdated=now,
                    pluginCount=official_count,
                )
            )
            save_known_marketplaces(self.storage_root, known)
        return known

    def add_marketplace(
        self,
        source_input: str | dict[str, Any],
        expected_id: str | None = None,
        trusted_id: str | None = None,
    ) -> tuple[KnownMarketplaceRecord, list[PluginDiagnostic]]:
        """Resolve a marketplace source, cache its manifest, and register it.

        Returns the record plus non-fatal diagnostics. Raises
        ``PluginManifestError`` / ``PluginSourceError`` on failure.
        """
        self.ensure_default_marketplaces()
        source = (
            source_input
            if isinstance(source_input, dict)
            else parse_marketplace_source_input(str(source_input))
        )
        manifest, resolved = resolve_marketplace_source_root(source)
        try:
            if manifest.name == EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE and manifest.name != trusted_id:
                raise PluginManifestError(
                    f'Cannot add a marketplace named "{manifest.name}": '
                    "that id is reserved for the official marketplace."
                )
            if expected_id and manifest.name != expected_id:
                raise PluginManifestError(
                    f"Marketplace declaration id mismatch: expected {expected_id}, "
                    f"received {manifest.name}"
                )
            # Stage the marketplace source tree into the cache dir (ZCode
            # stageMarketplaceDirectoryPlugins parity): relative plugin sources
            # must keep resolving after the original location disappears.
            # url/settings sources have no local tree — manifest only.
            if resolved is not None and resolved.path.is_dir():
                cache_dir = marketplace_manifest_path(self.storage_root, manifest.name).parent
                cache_dir.mkdir(parents=True, exist_ok=True)
                shutil.copytree(
                    resolved.path,
                    cache_dir,
                    dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".git"),
                )
            save_marketplace_manifest_cache(self.storage_root, manifest.raw)
            now = _now()
            record = KnownMarketplaceRecord(
                id=manifest.name,
                source=source,
                name=manifest.name,
                description=manifest.description,
                addedAt=now,
                lastUpdated=now,
                pluginCount=len(manifest.plugins),
            )
            upsert_known_marketplace(self.storage_root, record)
            return record, []
        finally:
            if resolved and resolved.cleanup:
                try:
                    resolved.cleanup()
                except Exception:
                    pass

    def remove_marketplace(self, marketplace: str) -> None:
        known = [
            record for record in load_known_marketplaces(self.storage_root) if record.id != marketplace
        ]
        save_known_marketplaces(self.storage_root, known)
        manifest_dir = marketplace_manifest_path(self.storage_root, marketplace).parent
        shutil.rmtree(manifest_dir, ignore_errors=True)

    def refresh_marketplace(
        self, marketplace: str | None = None
    ) -> tuple[list[KnownMarketplaceRecord], list[PluginDiagnostic]]:
        self.ensure_default_marketplaces()
        known = load_known_marketplaces(self.storage_root)
        selected = (
            known if marketplace is None else [record for record in known if record.id == marketplace]
        )
        if marketplace and not selected:
            raise PluginSourceError(f"Marketplace not found: {marketplace}")
        updated: list[KnownMarketplaceRecord] = []
        diagnostics: list[PluginDiagnostic] = []
        for record in selected:
            if record.id == EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE:
                seed_official_marketplace(self.storage_root)
                record.lastUpdated = _now()
                manifest = load_marketplace_manifest_cached(self.storage_root, record.id)
                if manifest:
                    record.pluginCount = len(manifest.plugins)
                updated.append(record)
                continue
            try:
                refreshed, _ = self.add_marketplace(record.source, trusted_id=record.id)
                updated.append(refreshed)
            except (PluginSourceError, PluginManifestError) as error:
                diagnostics.append(
                    PluginDiagnostic(
                        code="plugin_marketplace_invalid",
                        message=str(error),
                        pluginId=record.id,
                    )
                )
                record.lastRefreshFailure = {
                    "code": "plugin_marketplace_invalid",
                    "failedAt": _now(),
                    "message": str(error),
                }
        save_known_marketplaces(self.storage_root, load_known_marketplaces(self.storage_root))
        return updated, diagnostics

    # ------------------------------------------------------------------
    # Install / uninstall / update
    # ------------------------------------------------------------------

    def _resolve_dependency_closure(
        self, marketplace: str, name: str
    ) -> list[tuple[str, MarketplaceEntry, MarketplaceManifest]]:
        root_manifest = load_marketplace_manifest_cached(self.storage_root, marketplace)
        if root_manifest is None:
            raise PluginManifestError(f"Marketplace not found: {marketplace}")
        allow_cross = root_manifest.allow_cross_marketplace_dependencies_on
        closure: list[tuple[str, MarketplaceEntry, MarketplaceManifest]] = []
        visiting: list[str] = []
        visited: set[str] = set()

        def walk(plugin_id: str, required_by: str) -> None:
            dep_name, _, dep_marketplace = plugin_id.partition("@")
            if dep_marketplace != marketplace and dep_marketplace not in allow_cross:
                raise PluginManifestError(
                    f"Cross-marketplace dependency is blocked: {plugin_id} required by {required_by}"
                )
            if plugin_id in visiting:
                cycle = " -> ".join([*visiting, plugin_id])
                raise PluginManifestError(f"Plugin dependency cycle: {cycle}")
            if plugin_id in visited:
                return
            manifest = load_marketplace_manifest_cached(self.storage_root, dep_marketplace)
            if manifest is None:
                raise PluginManifestError(f"Marketplace not found for dependency: {dep_marketplace}")
            entry = manifest.entry(dep_name)
            if entry is None:
                raise PluginManifestError(f"Dependency not found: {plugin_id} required by {required_by}")
            visiting.append(plugin_id)
            for dependency in entry.dependencies:
                walk(dependency if "@" in dependency else f"{dependency}@{dep_marketplace}", plugin_id)
            visiting.pop()
            visited.add(plugin_id)
            closure.append((plugin_id, entry, manifest))

        walk(f"{name}@{marketplace}", f"{name}@{marketplace}")
        return closure

    def _cache_marketplace_plugin(
        self,
        plugin_id: str,
        entry: MarketplaceEntry,
        manifest: MarketplaceManifest,
        state: InstalledPluginsState,
        scope: str,
    ) -> InstalledPluginRecord:
        marketplace_dir = marketplace_manifest_path(self.storage_root, manifest.name).parent
        resolved = resolve_plugin_source_root(entry, manifest, marketplace_dir, self.storage_root)
        try:
            # Zip sources must produce a readable manifest whose name matches the
            # marketplace entry (ZCode assertZipPluginInstallRoot parity).
            from .zip_source import is_zip_plugin_url_source

            if is_zip_plugin_url_source(entry.source):
                zip_manifest = None
                try:
                    zip_manifest = read_plugin_manifest_from_root(resolved.path)
                except PluginManifestError as error:
                    raise PluginManifestError(
                        f"Plugin manifest not found: {plugin_id} ({error})"
                    ) from error
                if zip_manifest is None or zip_manifest.name != entry.name:
                    raise PluginManifestError(
                        f"Plugin manifest name {zip_manifest.name if zip_manifest else '<missing>'!r} "
                        f"does not match marketplace entry {entry.name!r}"
                    )
            version = resolve_installed_plugin_version(resolved.path, entry.version)
            from .storage import plugin_cache_dir

            target = plugin_cache_dir(self.storage_root, manifest.name, entry.name, version)
            if resolved.path.resolve() != target.resolve():
                copytree_atomic(resolved.path, target)
            if not entry.strict:
                self._ensure_entry_manifest(entry, target)
        finally:
            if resolved.cleanup:
                try:
                    resolved.cleanup()
                except Exception:
                    pass
        now = _now()
        record = InstalledPluginRecord(
            id=plugin_id,
            name=entry.name,
            marketplace=manifest.name,
            version=version,
            installPath=str(target),
            installedAt=now,
            updatedAt=now,
            scope=scope,
            dependencies=list(entry.dependencies),
            source=entry.source,
        )
        for index, existing in enumerate(state.plugins):
            if existing.id == record.id:
                record.installedAt = existing.installedAt or record.installedAt
                state.plugins[index] = record
                break
        else:
            state.plugins.append(record)
        state.enabled_plugins.setdefault(record.id, True)
        return record

    @staticmethod
    def _ensure_entry_manifest(entry: MarketplaceEntry, target: Path) -> None:
        if any(
            (target / relative).is_file()
            for relative in (".evoflow-plugin/plugin.json", ".zcode-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json")
        ):
            return
        from .manifest import create_manifest_from_marketplace_entry

        manifest_dir = target / ".evoflow-plugin"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        payload = create_manifest_from_marketplace_entry(entry)
        (manifest_dir / "plugin.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def install_plugin(
        self, marketplace: str, plugin_name: str, scope: str = "user"
    ) -> dict[str, Any]:
        self.ensure_default_marketplaces()
        manifest = load_marketplace_manifest_cached(self.storage_root, marketplace)
        if manifest is None:
            known = {record.id: record for record in load_known_marketplaces(self.storage_root)}
            if marketplace in known:
                self.refresh_marketplace(marketplace)
                manifest = load_marketplace_manifest_cached(self.storage_root, marketplace)
        if manifest is None:
            raise PluginManifestError(f"Marketplace not found: {marketplace}")
        entry = manifest.entry(plugin_name)
        if entry is None:
            raise PluginManifestError(f"Plugin not found: {plugin_name}@{marketplace}")
        name_error = validate_plugin_name(plugin_name)
        if name_error:
            raise PluginManifestError(name_error)
        state = load_installed_plugins_state(self.storage_root)
        closure = self._resolve_dependency_closure(marketplace, plugin_name)
        installed: list[InstalledPluginRecord] = []
        for plugin_id, closure_entry, closure_manifest in closure:
            installed.append(
                self._cache_marketplace_plugin(plugin_id, closure_entry, closure_manifest, state, scope)
            )
        save_installed_plugins_state(self.storage_root, state)
        ensure_plugin_data_dir(self.storage_root, f"{plugin_name}@{marketplace}")
        _ulog(
            f"install ok: {plugin_name}@{marketplace} scope={scope} closure={[pid for pid, _, _ in closure]}"
        )
        return {
            "installedPlugins": [self._installed_summary(record, state) for record in installed],
            "dependencyClosure": [plugin_id for plugin_id, _, _ in closure],
            "diagnostics": [],
        }

    def uninstall_plugin(self, plugin_id: str, remove_cache: bool = True) -> dict[str, Any]:
        state = load_installed_plugins_state(self.storage_root)
        record = next((item for item in state.plugins if item.id == plugin_id), None)
        if record is None:
            raise PluginManifestError(f"Plugin not installed: {plugin_id}")
        state.plugins = [item for item in state.plugins if item.id != plugin_id]
        state.enabled_plugins.pop(plugin_id, None)
        state.options.pop(plugin_id, None)
        save_installed_plugins_state(self.storage_root, state)
        _ulog(f"uninstall ok: {plugin_id} remove_cache={remove_cache}")
        removed_json = self._installed_summary(record, state)
        if remove_cache:
            install_path = resolve_installed_plugin_root(self.storage_root, record)
            shutil.rmtree(install_path, ignore_errors=True)
            shutil.rmtree(plugin_data_dir(self.storage_root, plugin_id), ignore_errors=True)
        return {"removedPlugin": removed_json, "diagnostics": []}

    def update_plugin(self, plugin_id: str) -> dict[str, Any]:
        state = load_installed_plugins_state(self.storage_root)
        record = next((item for item in state.plugins if item.id == plugin_id), None)
        if record is None:
            raise PluginManifestError(f"Plugin not installed: {plugin_id}")
        manifest = load_marketplace_manifest_cached(self.storage_root, record.marketplace)
        if manifest is None:
            raise PluginManifestError(f"Marketplace not found: {record.marketplace}")
        entry = manifest.entry(record.name)
        if entry is None:
            raise PluginManifestError(f"Plugin not found: {plugin_id}")
        self._cache_marketplace_plugin(plugin_id, entry, manifest, state, record.scope)
        save_installed_plugins_state(self.storage_root, state)
        _ulog(f"update ok: {plugin_id}")
        updated = [item for item in state.plugins if item.id == plugin_id]
        return {
            "installedPlugins": [self._installed_summary(item, state) for item in updated],
            "dependencyClosure": [plugin_id],
            "diagnostics": [],
        }

    def restore_builtin_plugin(self, plugin_id: str) -> dict[str, Any]:
        name, _, marketplace = plugin_id.partition("@")
        state = load_installed_plugins_state(self.storage_root)
        if any(item.id == plugin_id for item in state.plugins):
            state.enabled_plugins[plugin_id] = True
            save_installed_plugins_state(self.storage_root, state)
            return {"pluginId": plugin_id, "diagnostics": []}
        self.install_plugin(marketplace or EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE, name)
        return {"pluginId": plugin_id, "diagnostics": []}

    # ------------------------------------------------------------------
    # Enable state / configuration
    # ------------------------------------------------------------------

    def set_plugin_enabled(self, plugin_id: str, enabled: bool) -> dict[str, Any]:
        state = load_installed_plugins_state(self.storage_root)
        record = next((item for item in state.plugins if item.id == plugin_id), None)
        if record is None:
            raise PluginManifestError(f"Plugin not installed: {plugin_id}")
        state.enabled_plugins[plugin_id] = bool(enabled)
        save_installed_plugins_state(self.storage_root, state)
        _ulog(f"set-enabled ok: {plugin_id} enabled={bool(enabled)}")
        info = self._plugin_info(record, state)
        return {"plugin": info, "enabled": bool(enabled)}

    def configure_plugin(
        self,
        plugin_id: str,
        options: dict[str, Any],
        clear_option_keys: list[str] | None = None,
    ) -> dict[str, Any]:
        state = load_installed_plugins_state(self.storage_root)
        record = next((item for item in state.plugins if item.id == plugin_id), None)
        if record is None:
            raise PluginManifestError(f"Plugin not installed: {plugin_id}")
        current = dict(state.options.get(plugin_id, {}))
        for key, value in (options or {}).items():
            current[str(key)] = value
        for key in clear_option_keys or []:
            current.pop(str(key), None)
        state.options[plugin_id] = current
        save_installed_plugins_state(self.storage_root, state)
        return {"pluginId": plugin_id, "diagnostics": []}

    def reset_plugin_config(self, plugin_id: str) -> dict[str, Any]:
        state = load_installed_plugins_state(self.storage_root)
        if plugin_id not in state.options:
            return {"pluginId": plugin_id, "diagnostics": []}
        state.options.pop(plugin_id, None)
        save_installed_plugins_state(self.storage_root, state)
        return {"pluginId": plugin_id, "diagnostics": []}

    # ------------------------------------------------------------------
    # Projections
    # ------------------------------------------------------------------

    def _plugin_info(self, record: InstalledPluginRecord, state: InstalledPluginsState) -> dict[str, Any]:
        root = resolve_installed_plugin_root(self.storage_root, record)
        diagnostics: list[dict[str, Any]] = []
        manifest: Any = None
        try:
            manifest = read_plugin_manifest_from_root(root)
        except PluginManifestError as error:
            diagnostics.append(
                PluginDiagnostic(
                    code="plugin_manifest_invalid",
                    message=str(error),
                    pluginId=record.id,
                ).to_json()
            )
        components = enumerate_plugin_components(root, manifest, diagnostics) if root.is_dir() else []
        skill_count = 0
        skill_root_count = 0
        command_root_count = 0
        mcp_server_names: list[str] = []
        for group in components:
            if group["kind"] == "skill":
                skill_count = len(group["items"])
                skill_root_count = 1
            elif group["kind"] == "command":
                command_root_count = 1
            elif group["kind"] == "mcp":
                mcp_server_names = [item["name"] for item in group["items"]]
        info: dict[str, Any] = {
            "id": record.id,
            "name": record.name,
            "version": record.version,
            "enabled": state.is_enabled(record.id),
            "source": "cache",
            "marketplace": record.marketplace,
            "skillCount": skill_count,
            "skillRootCount": skill_root_count,
            "commandRootCount": command_root_count,
            "mcpServerNames": mcp_server_names,
            "components": components,
            "rootPath": str(root),
        }
        if manifest is not None:
            if manifest.description:
                info["description"] = manifest.description
            metadata = manifest.display_metadata()
            if "author" in metadata:
                info["author"] = metadata["author"]
            if "authorUrl" in metadata:
                info["authorUrl"] = metadata["authorUrl"]
            if "homepage" in metadata:
                info["homepage"] = metadata["homepage"]
            if manifest.user_config:
                info["userConfig"] = manifest.user_config
        configured = state.options.get(record.id)
        if configured:
            info["configuredOptions"] = configured
        for diagnostic in diagnostics:
            info.setdefault("diagnostics", []).append(diagnostic)
        return info

    def _installed_summary(
        self, record: InstalledPluginRecord, state: InstalledPluginsState
    ) -> dict[str, Any]:
        root = resolve_installed_plugin_root(self.storage_root, record)
        manifest: Any = None
        try:
            manifest = read_plugin_manifest_from_root(root)
        except PluginManifestError:
            manifest = None
        components = enumerate_plugin_components(root, manifest) if root.is_dir() else []
        listing = None
        cached_manifest = load_marketplace_manifest_cached(self.storage_root, record.marketplace)
        if cached_manifest is not None:
            entry = cached_manifest.entry(record.name)
            if entry is not None:
                listing = entry.listing()
        summary: dict[str, Any] = {
            "id": record.id,
            "name": record.name,
            "marketplace": record.marketplace,
            "version": record.version,
            "enabled": state.is_enabled(record.id),
            "scope": record.scope if record.scope in ("user", "workspace") else "user",
            "installedAt": record.installedAt,
            "componentTypes": component_types_from_groups(components),
        }
        # 描述优先取市场 listing（品牌文案与商店一致），回退到插件自带 manifest。
        if listing and listing.get("description"):
            summary["description"] = listing["description"]
        elif manifest is not None and manifest.description:
            summary["description"] = manifest.description
        if record.installPath:
            summary["installPath"] = record.installPath
        listing = _listing_with_local_icon(self.storage_root, record.name, listing)
        if listing:
            summary["listing"] = listing
        return summary

    def list_plugins(self) -> dict[str, Any]:
        self.ensure_default_marketplaces()
        state = load_installed_plugins_state(self.storage_root)
        plugins = [self._plugin_info(record, state) for record in state.plugins]
        diagnostics: list[dict[str, Any]] = []
        for record in state.plugins:
            root = resolve_installed_plugin_root(self.storage_root, record)
            if not root.is_dir():
                diagnostics.append(
                    PluginDiagnostic(
                        code="plugin_root_not_found",
                        message=f"Installed plugin root is missing: {record.id}",
                        pluginId=record.id,
                    ).to_json()
                )
        return {"plugins": plugins, "diagnostics": diagnostics}

    def overview(self) -> dict[str, Any]:
        known = self.ensure_default_marketplaces()
        state = load_installed_plugins_state(self.storage_root)
        installed_ids = {record.id for record in state.plugins}

        marketplaces_json: list[dict[str, Any]] = []
        available_json: list[dict[str, Any]] = []
        restorable_json: list[dict[str, Any]] = []
        diagnostics: list[dict[str, Any]] = []

        for record in known:
            manifest = load_marketplace_manifest_cached(self.storage_root, record.id)
            summary: dict[str, Any] = {
                "id": record.id,
                "name": record.name,
                "source": record.source,
                "pluginCount": len(manifest.plugins) if manifest else record.pluginCount,
                "isOfficial": record.id == EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE,
            }
            if record.description:
                summary["description"] = record.description
            if record.lastUpdated:
                summary["lastUpdated"] = record.lastUpdated
            if manifest and manifest.featured:
                summary["featured"] = manifest.featured
            if record.lastRefreshFailure:
                summary["refreshFailure"] = record.lastRefreshFailure
                diagnostics.append(
                    PluginDiagnostic(
                        code=str(record.lastRefreshFailure.get("code") or "plugin_marketplace_invalid"),
                        message=str(record.lastRefreshFailure.get("message") or "Marketplace refresh failed"),
                        pluginId=record.id,
                    ).to_json()
                )
            marketplaces_json.append(summary)

            if manifest is None:
                continue
            for entry in manifest.plugins:
                plugin_id = f"{entry.name}@{record.id}"
                available: dict[str, Any] = {
                    "id": plugin_id,
                    "name": entry.name,
                    "marketplace": record.id,
                    "installed": plugin_id in installed_ids,
                }
                if entry.description:
                    available["description"] = entry.description
                if entry.version:
                    available["version"] = entry.version
                listing = entry.listing()
                if listing:
                    available["listing"] = listing
                available_json.append(available)
                if record.id == EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE and plugin_id not in installed_ids:
                    restorable_json.append(dict(available))

        installed_json = [
            self._installed_summary(record, state)
            for record in state.plugins
            if record.name not in EXCLUDED_OFFICIAL_PLUGINS
        ]
        return {
            "marketplaces": marketplaces_json,
            "availablePlugins": available_json,
            "installedPlugins": installed_json,
            "restorableBuiltins": restorable_json,
            "diagnostics": diagnostics,
            "capability": {"supported": True},
        }

    def describe_plugin(self, marketplace: str, plugin_name: str) -> dict[str, Any]:
        state = load_installed_plugins_state(self.storage_root)
        record = next(
            (
                item
                for item in state.plugins
                if item.marketplace == marketplace and item.name == plugin_name
            ),
            None,
        )
        if record is not None:
            root = resolve_installed_plugin_root(self.storage_root, record)
            if root.is_dir():
                diagnostics: list[dict[str, Any]] = []
                manifest: Any = None
                try:
                    manifest = read_plugin_manifest_from_root(root)
                except PluginManifestError as error:
                    diagnostics.append(
                        PluginDiagnostic(
                            code="plugin_manifest_invalid", message=str(error), pluginId=record.id
                        ).to_json()
                    )
                result: dict[str, Any] = {
                    "components": enumerate_plugin_components(root, manifest, diagnostics)
                }
                if diagnostics:
                    result["diagnostics"] = diagnostics
                if manifest is not None:
                    metadata = manifest.display_metadata()
                    if metadata:
                        result["metadata"] = metadata
                return result

        manifest = self._manifest_available(marketplace)
        if manifest is None:
            return {
                "components": [],
                "diagnostics": [
                    PluginDiagnostic(
                        code="plugin_marketplace_invalid",
                        message=f"Marketplace not found: {marketplace}",
                        pluginId=f"{plugin_name}@{marketplace}",
                    ).to_json()
                ],
            }
        entry = manifest.entry(plugin_name)
        if entry is None:
            return {
                "components": [],
                "diagnostics": [
                    PluginDiagnostic(
                        code="plugin_not_found",
                        message=f"Plugin not found: {plugin_name}@{marketplace}",
                        pluginId=f"{plugin_name}@{marketplace}",
                    ).to_json()
                ],
            }
        marketplace_dir = marketplace_manifest_path(self.storage_root, marketplace).parent
        diagnostics = []
        try:
            resolved = resolve_plugin_source_root(entry, manifest, marketplace_dir, self.storage_root)
        except (PluginSourceError, PluginManifestError) as error:
            return {
                "components": [],
                "diagnostics": [
                    PluginDiagnostic(
                        code="plugin_manifest_not_found",
                        message=str(error),
                        pluginId=f"{plugin_name}@{marketplace}",
                    ).to_json()
                ],
            }
        try:
            manifest_at_root: Any = None
            try:
                manifest_at_root = read_plugin_manifest_from_root(resolved.path)
            except PluginManifestError as error:
                diagnostics.append(
                    PluginDiagnostic(
                        code="plugin_manifest_invalid",
                        message=str(error),
                        pluginId=f"{plugin_name}@{marketplace}",
                    ).to_json()
                )
            result = {"components": enumerate_plugin_components(resolved.path, manifest_at_root, diagnostics)}
            if diagnostics:
                result["diagnostics"] = diagnostics
            if manifest_at_root is not None:
                metadata = manifest_at_root.display_metadata()
                if metadata:
                    result["metadata"] = metadata
            return result
        finally:
            if resolved.cleanup:
                try:
                    resolved.cleanup()
                except Exception:
                    pass

    def validate_source(self, source_input: str) -> dict[str, Any]:
        try:
            source = parse_marketplace_source_input(source_input)
        except PluginSourceError as error:
            return {
                "ok": False,
                "diagnostics": [
                    PluginDiagnostic(code="plugin_marketplace_source_unsupported", message=str(error)).to_json()
                ],
                "compatibility": {"runnable": [], "diagnosticOnly": [], "unsupported": []},
            }
        diagnostics = [
            item.to_json() for item in validate_marketplace_source_only(source)
        ]
        return {
            "ok": not any(item["severity"] == "error" for item in diagnostics),
            "diagnostics": diagnostics,
            "compatibility": {"runnable": [], "diagnosticOnly": [], "unsupported": []},
        }

    def reference_catalog(self) -> dict[str, Any]:
        state = load_installed_plugins_state(self.storage_root)
        entries: list[dict[str, Any]] = []
        for record in state.plugins:
            root = resolve_installed_plugin_root(self.storage_root, record)
            manifest: Any = None
            try:
                manifest = read_plugin_manifest_from_root(root)
            except PluginManifestError:
                manifest = None
            components = enumerate_plugin_components(root, manifest) if root.is_dir() else []
            skill_names = [
                f"{record.name}:{item['name']}"
                for group in components
                if group["kind"] == "skill"
                for item in group["items"]
            ]
            mcp_names = [
                f"plugin:{record.name}:{item['name']}"
                for group in components
                if group["kind"] == "mcp"
                for item in group["items"]
            ]
            subagent_names = [
                f"{record.name}:{item['name']}"
                for group in components
                if group["kind"] == "agent"
                for item in group["items"]
            ]
            same_name = [
                other.id
                for other in state.plugins
                if other.id != record.id and other.name == record.name and state.is_enabled(other.id)
            ]
            entries.append(
                {
                    "pluginId": record.id,
                    "name": record.name,
                    "marketplace": record.marketplace,
                    "enabled": state.is_enabled(record.id),
                    "conflictingPluginIds": same_name,
                    "skillQualifiedNames": skill_names,
                    "mcpServerNames": mcp_names,
                    "subagentNames": subagent_names,
                }
            )
        return {"authority": "workspace", "plugins": entries}

    def _manifest_available(self, marketplace: str) -> MarketplaceManifest | None:
        manifest = load_marketplace_manifest_cached(self.storage_root, marketplace)
        if manifest is not None:
            return manifest
        known = {record.id: record for record in load_known_marketplaces(self.storage_root)}
        if marketplace not in known:
            return None
        try:
            self.refresh_marketplace(marketplace)
        except PluginSourceError:
            return None
        return load_marketplace_manifest_cached(self.storage_root, marketplace)


__all__ = ["PluginManagementService", "EVOFLOW_OFFICIAL_PLUGIN_MARKETPLACE", "DEFAULT_VERSION"]
