# Official plugins bundle (installer marketplace)

Product installers ship curated official plugins under
`_internal/evoflow/plugins/bundled_official` (PyInstaller datas).

## What lives in git

| Path | Tracked? | Notes |
| --- | --- | --- |
| `packaging/official-plugins-bundle.tar.gz` | **yes** (~20MB) | Source of truth for CI / clean clones |
| `packaging/official-plugins-bundle/` | no (gitignored) | Unpacked working tree for PyInstaller |

`fetch-official-plugins-bundle` unpacks the committed `.tar.gz` into the working
directory before preflight / gateway build. No external URL or Release asset is
required for a normal release.

Without a real bundle, the marketplace is empty and browser-use / computer-use
do not work. Fetch/preflight/gateway-build **reject stubs**.

## Local / CI build

```powershell
# Unpacks packaging/official-plugins-bundle.tar.gz if the working tree is empty:
.\backend\packaging\windows\fetch-official-plugins-bundle.ps1

# Or Unix:
bash backend/packaging/fetch-official-plugins-bundle.sh
```

Then build the gateway as usual. An empty or stub bundle **fails** the build.

## Updating the plugins

On a machine with a current official plugin cache:

```powershell
.\backend\packaging\windows\sync-official-plugins-bundle.ps1
bash backend/packaging/pack-official-plugins-bundle.sh
# commit the refreshed official-plugins-bundle.tar.gz
```

Optional overrides (rarely needed): `EVOFLOW_OFFICIAL_PLUGINS_SOURCE` /
`EVOFLOW_OFFICIAL_PLUGINS_URL` / `EVOFLOW_OFFICIAL_PLUGINS_RELEASE`.

Dev-only escape hatch (never on release): `EVOFLOW_ALLOW_OFFICIAL_PLUGINS_STUB=1`.

Installers keep **one** copy of the plugins (in-package). A sidecar
`official-plugins-bundle/` next to the gateway exe is treated as an error by
lean-assert (avoids ~50MB duplicate).
