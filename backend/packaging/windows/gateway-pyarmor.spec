# -*- mode: python ; coding: utf-8 -*-
"""
PyArmor-protected PyInstaller spec for EvoFlow Gateway.

Usage:
  1. Run obfuscate-with-pyarmor.ps1 first (or build-gateway-exe.ps1 -EnablePyArmor)
  2. pyinstaller gateway-pyarmor.spec

This spec uses obfuscated code from .build-temp/obfuscated/ instead of source.
PyArmor replaces .pyc with encrypted bytecode that cannot be decompiled by uncompyle6.
"""

from pathlib import Path
import os
import sys
import sysconfig

from PyInstaller.utils.hooks import collect_all, collect_dynamic_libs, collect_submodules, copy_metadata

_INCLUDE_LOCAL_EMBEDDING = os.environ.get(
    "EVOFLOW_GATEWAY_INCLUDE_LOCAL_EMBEDDING", ""
).strip().lower() in {"1", "true", "yes", "on"}

backend_root = Path.cwd()
spec_dir = backend_root / "packaging" / "windows"
harness_root = backend_root / "packages" / "harness"

# PyArmor obfuscated output directory
obfuscated_root = backend_root / ".build-temp" / "obfuscated"

_IS_DARWIN = sys.platform == "darwin"
_MACOS_CODESIGN = False if _IS_DARWIN else None


def _filesystem_submodules(package: str, root: Path) -> list:
    """Collect module names by scanning .py files (PyInstaller import graph may miss new middleware)."""
    out = []
    if not root.is_dir():
        return out
    for py in sorted(root.rglob("*.py")):
        if py.name == "__init__.py":
            continue
        rel = py.relative_to(root).with_suffix("")
        parts = list(rel.parts)
        if not parts:
            continue
        out.append(package + "." + ".".join(parts))
    return out


_harness_evoflow = harness_root / "evoflow"

hiddenimports = []
hiddenimports += ["app", "app.gateway", "app.gateway.app"]
hiddenimports += collect_submodules("app.gateway.routers")
# Same pin as gateway.spec — obfuscated builds must still ship models router.
hiddenimports += _filesystem_submodules("app.gateway.routers", backend_root / "app" / "gateway" / "routers")
hiddenimports += ["app.gateway.routers.models"]
# Same pin as gateway.spec — v4 must ship or extended registration used to abort.
hiddenimports += collect_submodules("app.gateway.v4", on_error="ignore")
hiddenimports += _filesystem_submodules("app.gateway.v4", backend_root / "app" / "gateway" / "v4")
hiddenimports += ["app.gateway.v4", "app.gateway.v4.routes"]
hiddenimports += collect_submodules("app.channels", on_error="ignore")
hiddenimports += _filesystem_submodules("evoflow.agents.middlewares", _harness_evoflow / "agents" / "middlewares")
hiddenimports += collect_submodules("evoflow", on_error="ignore")
hiddenimports += collect_submodules("evoflow.code_index", on_error="ignore")
hiddenimports += collect_submodules("uvicorn", on_error="ignore")
hiddenimports += ["zstandard.backend_c"]
hiddenimports += collect_submodules("zstandard", on_error="ignore")
hiddenimports = list(dict.fromkeys(hiddenimports))

if "app.gateway.routers.models" not in hiddenimports:
    raise SystemExit(
        "gateway-pyarmor.spec: app.gateway.routers.models missing from hiddenimports "
        "(desktop Gateway would 503 /api/models)"
    )
if "app.gateway.v4.routes" not in hiddenimports:
    raise SystemExit(
        "gateway-pyarmor.spec: app.gateway.v4.routes missing from hiddenimports "
        "(desktop Gateway extended registration aborts → loading_extended 503)"
    )

block_cipher = None
site_packages_dir = Path(sysconfig.get_paths()["purelib"])
datas = [(str(backend_root.parent / "config.example.yaml"), ".")]
openapi_json = site_packages_dir / "openapi.json"
if openapi_json.exists():
    datas.append((str(openapi_json), "."))

# Non-.py package assets (keep in sync with gateway.spec)
# prompts/: Asset Hub memory templates — Phase2 consolidate needs consolidation.md
_assets_root = _harness_evoflow / "assets"
for _asset_subdir in (
    "builtin_agent_avatars",
    "avatar_presets",
    "builtin_agent_souls",
    "prompts",
):
    _src = _assets_root / _asset_subdir
    if _src.is_dir():
        datas.append((str(_src), f"evoflow/assets/{_asset_subdir}"))
_consolidation = _assets_root / "prompts" / "memories" / "consolidation.md"
if not _consolidation.is_file():
    raise SystemExit(
        "gateway-pyarmor.spec: evoflow/assets/prompts/memories/consolidation.md missing "
        "(Phase2 memory consolidate would FileNotFoundError on desktop install)"
    )

# System builtin user guide (docs/user → owned KB seed for 小V / 知识库).
_docs_user = backend_root.parent / "docs" / "user"
if not _docs_user.is_dir() or not any(_docs_user.rglob("*.md")):
    raise SystemExit(
        "gateway-pyarmor.spec: docs/user missing or has no .md "
        "(builtin user-guide KB would seed empty on desktop install)"
    )
datas.append((str(_docs_user), "evoflow/assets/builtin_knowledge_vaults/user-guide"))
_docs_knowledge = (
    backend_root.parent.parent / "ContentOS" / "docs" / "智能内容运营平台" / "知识库"
)
if _docs_knowledge.is_dir():
    datas.append((str(_docs_knowledge), "evoflow/assets/builtin_knowledge_vaults/ops-knowledge"))

# Official product plugins — single in-package copy (same as gateway.spec).
_official_plugins = backend_root / "packaging" / "official-plugins-bundle"
_official_plugin_dirs = [
    p for p in _official_plugins.iterdir() if p.is_dir()
] if _official_plugins.is_dir() else []
if not _official_plugin_dirs:
    raise SystemExit(
        "[gateway-pyarmor.spec] official-plugins-bundle is empty — run "
        "packaging/fetch-official-plugins-bundle.sh (or sync-official-plugins-bundle) "
        "before PyInstaller"
    )
datas.append((str(_official_plugins), "evoflow/plugins/bundled_official"))

_plugins_pkg = _harness_evoflow / "plugins"
for _sidecar_name in ("cua_exec.ps1", "evoflow_node_repl_preload.cjs"):
    _sidecar = _plugins_pkg / _sidecar_name
    if _sidecar.is_file():
        datas.append((str(_sidecar), "evoflow/plugins"))

# langgraph/version.py uses importlib.metadata.version()
try:
    datas += copy_metadata("langgraph")
except Exception:
    pass

# PyArmor runtime files (pyarmor_runtime_*.pyd / .so)
# PyArmor puts them in the obfuscated output directory
if obfuscated_root.is_dir():
    for runtime_file in obfuscated_root.rglob("pyarmor_runtime*"):
        if runtime_file.is_file():
            datas.append((str(runtime_file.parent), "."))

# Third-party packages
binaries = []
binaries += collect_dynamic_libs("zstandard")

_CORE_PKGS = (
    "certifi",
    "aiohttp",
    "cryptography",
    "qrcode",
    "tiktoken",
    "tree_sitter",
    "tree_sitter_languages",
    "javalang",
)
_LOCAL_EMBED_PKGS = (
    "sentence_transformers",
    "transformers",
    "torch",
    "huggingface_hub",
    "tokenizers",
    "safetensors",
    "scipy",
    "sklearn",
)
for _pkg in _CORE_PKGS + (_LOCAL_EMBED_PKGS if _INCLUDE_LOCAL_EMBEDDING else ()):
    try:
        _d, _b, _h = collect_all(_pkg)
        datas += list(_d)
        binaries += list(_b)
        hiddenimports += list(_h)
    except Exception:
        pass
try:
    binaries += collect_dynamic_libs("tree_sitter")
except Exception:
    pass
if _INCLUDE_LOCAL_EMBEDDING:
    try:
        binaries += collect_dynamic_libs("torch")
    except Exception:
        pass
    try:
        binaries += collect_dynamic_libs("scipy")
    except Exception:
        pass
    try:
        hiddenimports += collect_submodules("scipy._external")
    except Exception:
        pass
hiddenimports += [
    "tiktoken_ext",
    "tiktoken_ext.openai_public",
    "ast",
    "timeit",
    "javalang.parser",
    "javalang.tree",
    "tree_sitter_languages.core",
]
if _INCLUDE_LOCAL_EMBEDDING:
    hiddenimports += [
        "sentence_transformers",
        "transformers",
        "torch",
        "scipy",
        "sklearn",
        "scipy._external.array_api_compat.numpy.fft",
    ]

_excludes = []
if not _INCLUDE_LOCAL_EMBEDDING:
    _excludes = [
        "torch",
        "torchvision",
        "torchaudio",
        "sentence_transformers",
        "transformers",
        "sklearn",
        "scipy",
    ]

# pipecat-ai / onnxruntime>=1.24 have no macOS Intel wheels; skip voice stack there.
try:
    import pipecat  # noqa: F401
except ImportError:
    _excludes += [
        "pipecat",
        "app.gateway.speech.runtime.processors.pipecat_voice_bridge",
        "app.gateway.speech.runtime.processors.pipecat_tts_bridge",
        "app.gateway.speech.runtime.pipecat_volc_stt",
        "app.gateway.speech.runtime.pipecat_volc_tts",
    ]

# Key difference from gateway.spec: use obfuscated code path
# pathex includes obfuscated directory FIRST so PyArmor-protected modules load before source
a = Analysis(
    [str(spec_dir / "gateway_entry.py")],
    pathex=[
        str(obfuscated_root),  # PyArmor obfuscated code (highest priority)
        str(backend_root),
        str(harness_root),
    ],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[str(spec_dir / "pyi_rth_evoflow_stdio.py")],
    excludes=_excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    [],
    [],
    name="evoflow-gateway",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=_MACOS_CODESIGN,
    entitlements_file=None,
    exclude_binaries=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="evoflow-gateway",
    codesign_identity=_MACOS_CODESIGN,
    entitlements_file=None,
)
