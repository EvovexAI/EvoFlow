#!/usr/bin/env bash
#
# config-upgrade.sh - Upgrade config.yaml to match config.example.yaml
#
# 1. Runs version-specific migrations (value replacements, renames, etc.)
# 2. Merges missing fields from the example into the user config
# 3. Backs up config.yaml to config.yaml.bak before modifying.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$REPO_ROOT/config.example.yaml"
UV_BIN="${UV_BIN:-uv}"
if [ -x "$HOME/.local/bin/uv" ]; then
    UV_BIN="$HOME/.local/bin/uv"
fi

# Match serve.sh: WSL + /mnt/* uses $HOME/.venvs/evoflow-backend; else backend/.venv-wsl.
_DEFAULT_UV_ENV=".venv-wsl"
if [ -f /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
    case "$REPO_ROOT" in
        /mnt/*)
            _DEFAULT_UV_ENV="${HOME}/.venvs/evoflow-backend"
            mkdir -p "$(dirname "$_DEFAULT_UV_ENV")"
            ;;
    esac
fi
export UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-$_DEFAULT_UV_ENV}"
export UV_LINK_MODE="${UV_LINK_MODE:-copy}"
if [ "${EVOFLOW_SKIP_NATIVE_WSL_VENV:-0}" != "1" ] && [ -f /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
    case "$REPO_ROOT" in
        /mnt/*)
            export UV_PROJECT_ENVIRONMENT="${HOME}/.venvs/evoflow-backend"
            mkdir -p "$(dirname "$UV_PROJECT_ENVIRONMENT")"
            ;;
    esac
fi

# Resolve config.yaml location: env var > backend/ > repo root
if [ -n "$EVOFLOW_CONFIG_PATH" ] && [ -f "$EVOFLOW_CONFIG_PATH" ]; then
    CONFIG="$EVOFLOW_CONFIG_PATH"
elif [ -f "$REPO_ROOT/backend/config.yaml" ]; then
    CONFIG="$REPO_ROOT/backend/config.yaml"
elif [ -f "$REPO_ROOT/config.yaml" ]; then
    CONFIG="$REPO_ROOT/config.yaml"
else
    CONFIG=""
fi

if [ ! -f "$EXAMPLE" ]; then
    echo "✗ config.example.yaml not found at $EXAMPLE"
    exit 1
fi

if [ -z "$CONFIG" ]; then
    echo "No config.yaml found — creating from example..."
    cp "$EXAMPLE" "$REPO_ROOT/config.yaml"
    echo "✓ config.yaml created. Please review and set your API keys."
    exit 0
fi

# Use inline Python to do migrations + recursive merge with PyYAML
cd "$REPO_ROOT/backend" && "$UV_BIN" run python3 -c "
import sys, shutil, copy, re
from pathlib import Path

import yaml

config_path = Path('$CONFIG')
example_path = Path('$EXAMPLE')

with open(config_path, encoding='utf-8') as f:
    raw_text = f.read()
    user = yaml.safe_load(raw_text) or {}

with open(example_path, encoding='utf-8') as f:
    example = yaml.safe_load(f) or {}

user_version = user.get('config_version', 0)
example_version = example.get('config_version', 0)

if user_version >= example_version:
    print(f'✓ config.yaml is already up to date (version {user_version}).')
    sys.exit(0)

print(f'Upgrading config.yaml: version {user_version} → {example_version}')
print()

# ── Migrations ───────────────────────────────────────────────────────────
# Each migration targets a specific version upgrade.
# 'replacements': list of (old_string, new_string) applied to the raw YAML text.
#   This handles value changes that a dict merge cannot catch.

MIGRATIONS = {
    1: {
        'description': 'Rename src.* module paths to evoflow.*',
        'replacements': [
            ('src.community.', 'evoflow.community.'),
            ('src.sandbox.', 'evoflow.sandbox.'),
            ('src.models.', 'evoflow.models.'),
            ('src.tools.', 'evoflow.tools.'),
        ],
    },
    # Future migrations go here:
    # 2: {
    #     'description': '...',
    #     'replacements': [('old', 'new')],
    # },
}

# Apply migrations in order for versions (user_version, example_version]
migrated = []
for version in range(user_version + 1, example_version + 1):
    migration = MIGRATIONS.get(version)
    if not migration:
        continue
    desc = migration.get('description', f'Migration to v{version}')
    for old, new in migration.get('replacements', []):
        if old in raw_text:
            raw_text = raw_text.replace(old, new)
            migrated.append(f'{old} → {new}')

# Re-parse after text migrations
user = yaml.safe_load(raw_text) or {}

if migrated:
    print(f'Applied {len(migrated)} migration(s):')
    for m in migrated:
        print(f'  ~ {m}')
    print()

# ── Merge missing fields ─────────────────────────────────────────────────

added = []

def merge(target, source, path=''):
    \"\"\"Recursively merge source into target, adding missing keys only.\"\"\"
    for key, value in source.items():
        key_path = f'{path}.{key}' if path else key
        if key not in target:
            target[key] = copy.deepcopy(value)
            added.append(key_path)
        elif isinstance(value, dict) and isinstance(target[key], dict):
            merge(target[key], value, key_path)

merge(user, example)

# Always update config_version
user['config_version'] = example_version

# ── Write ─────────────────────────────────────────────────────────────────

backup = config_path.with_suffix('.yaml.bak')
shutil.copy2(config_path, backup)
print(f'Backed up to {backup.name}')

with open(config_path, 'w', encoding='utf-8') as f:
    yaml.dump(user, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

if added:
    print(f'Added {len(added)} new field(s):')
    for a in added:
        print(f'  + {a}')

if not migrated and not added:
    print('No changes needed (version bumped only).')

print()
print(f'✓ config.yaml upgraded to version {example_version}.')
print('  Please review the changes and set any new required values.')
"
