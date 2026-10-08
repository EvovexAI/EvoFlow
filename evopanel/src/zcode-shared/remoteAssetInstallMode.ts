export const REMOTE_ASSET_INSTALL_MODES = ["local-download-upload", "remote-download"] as const;

export type RemoteAssetInstallMode = (typeof REMOTE_ASSET_INSTALL_MODES)[number];

export const DEFAULT_REMOTE_ASSET_INSTALL_MODE: RemoteAssetInstallMode = "local-download-upload";

export function normalizeRemoteAssetInstallMode(
  mode?: RemoteAssetInstallMode | null,
): RemoteAssetInstallMode {
  return mode === "remote-download" ? mode : DEFAULT_REMOTE_ASSET_INSTALL_MODE;
}
