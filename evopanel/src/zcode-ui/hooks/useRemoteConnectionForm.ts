import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import { DEFAULT_REMOTE_ASSET_INSTALL_MODE } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  loadRemoteConnectionDockerOptions,
  resolveDockerContainerSelectionAfterRefresh,
} from "@/lib/remoteConnectionDockerOptions.js";

type RemoteKind = RemoteTarget["kind"];
export type SSHAuthMethod = "password" | "privateKey";

function buildAvailableKinds(options: { isWindowsDesktop: boolean }): RemoteKind[] {
  const kinds: RemoteKind[] = ["ssh"];
  // 远程连接入口里 WSL 和 SSH 同属主机类连接。
  // Windows 下先放 WSL 再放 Docker，避免 WSL 被 Docker 隔开后在选择页显得离 SSH 很远。
  if (options.isWindowsDesktop) {
    kinds.push("wsl");
  }
  // Docker入口之前完全依赖预探测结果决定是否展示。
  // 当探测能力暂时不可用、或用户还没切到 Docker 时，入口会直接消失，
  // 用户甚至不知道这里支持 Docker 连接。改为始终展示入口，切换后再懒加载探测结果。
  kinds.push("docker");
  return kinds;
}

export function useRemoteConnectionForm({
  open,
  isWindowsDesktop,
  preferredKind,
  preferredWslDistro,
}: {
  open: boolean;
  isWindowsDesktop: boolean;
  preferredKind?: RemoteKind;
  preferredWslDistro?: string;
}) {
  const platform = usePlatform();
  const [kind, setKind] = useState<RemoteKind>("ssh");
  const [host, setHostState] = useState("");
  const [port, setPortState] = useState("22");
  const [username, setUsernameState] = useState("");
  const [sshAuthMethod, setSshAuthMethod] = useState<SSHAuthMethod>("password");
  const [assetInstallMode, setAssetInstallMode] = useState<RemoteAssetInstallMode>(
    DEFAULT_REMOTE_ASSET_INSTALL_MODE,
  );
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPathState] = useState("");
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState("");
  const [wslDistro, setWslDistro] = useState("");
  const [wslUser, setWslUser] = useState("");
  const [dockerContainer, setDockerContainer] = useState("");
  const [manualDockerContainer, setManualDockerContainer] = useState("");
  const [sshConfigAliases, setSshConfigAliases] = useState<SSHConfigAliasOption[]>([]);
  const [sshConfigAliasesLoading, setSshConfigAliasesLoading] = useState(false);
  const [sshConfigAliasesLoaded, setSshConfigAliasesLoaded] = useState(false);
  const [sshConfigAliasesError, setSshConfigAliasesError] = useState("");
  const [selectedSshConfigAlias, setSelectedSshConfigAlias] = useState<string | null>(null);
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [wslDistros, setWslDistros] = useState<WSLDistro[]>([]);
  const [dockerContainers, setDockerContainers] = useState<DockerContainerInfo[]>([]);
  const [wslOptionsLoading, setWslOptionsLoading] = useState(false);
  const [wslOptionsLoaded, setWslOptionsLoaded] = useState(false);
  const [wslOptionsError, setWslOptionsError] = useState("");
  const [dockerOptionsLoading, setDockerOptionsLoading] = useState(false);
  const [dockerOptionsLoaded, setDockerOptionsLoaded] = useState(false);
  const [dockerOptionsError, setDockerOptionsError] = useState("");
  const applyingSshAliasRef = useRef(false);
  const dockerOptionsActiveLoadIdRef = useRef(0);
  const dockerOptionsInFlightLoadIdRef = useRef<number | null>(null);
  const availableKinds = useMemo(
    () => buildAvailableKinds({ isWindowsDesktop }),
    [isWindowsDesktop],
  );

  useEffect(() => {
    if (availableKinds.includes(kind)) {
      return;
    }

    setKind(availableKinds[0] ?? "ssh");
  }, [availableKinds, kind]);

  useEffect(() => {
    dockerOptionsActiveLoadIdRef.current += 1;
    dockerOptionsInFlightLoadIdRef.current = null;

    if (!open) {
      return;
    }

    setSshConfigAliases([]);
    setSshConfigAliasesLoading(false);
    setSshConfigAliasesLoaded(false);
    setSshConfigAliasesError("");
    setSelectedSshConfigAlias(null);
    setWslOptionsLoaded(false);
    setWslOptionsLoading(false);
    setWslOptionsError("");
    setWslDistros([]);
    setDockerAvailable(null);
    setDockerOptionsLoaded(false);
    setDockerOptionsLoading(false);
    setDockerOptionsError("");
    setDockerContainers([]);
    if (preferredKind && availableKinds.includes(preferredKind)) {
      setKind(preferredKind);
    }
    if (preferredWslDistro !== undefined) {
      setWslDistro(preferredWslDistro);
    }
  }, [availableKinds, open, preferredKind, preferredWslDistro]);

  const refreshDockerContainers = useCallback(
    ({ clearContainersOnError = true }: { clearContainersOnError?: boolean } = {}) => {
      if (
        dockerOptionsInFlightLoadIdRef.current != null &&
        dockerOptionsInFlightLoadIdRef.current === dockerOptionsActiveLoadIdRef.current
      ) {
        return;
      }

      const loadId = dockerOptionsActiveLoadIdRef.current + 1;
      dockerOptionsActiveLoadIdRef.current = loadId;
      dockerOptionsInFlightLoadIdRef.current = loadId;
      setDockerOptionsLoading(true);
      setDockerOptionsError("");

      void (async () => {
        const result = await loadRemoteConnectionDockerOptions(platform);
        if (dockerOptionsActiveLoadIdRef.current !== loadId) {
          return;
        }

        setDockerAvailable(result.dockerAvailable);
        setDockerOptionsLoaded(true);
        setDockerOptionsError(result.error);

        if (!result.error) {
          setDockerContainers(result.dockerContainers);
          // 下拉刷新后旧容器可能已经停止。之前只更新列表不清空选中值，
          // 触发器仍会显示已不存在的容器；成功刷新后必须让选中值受最新运行中列表约束。
          setDockerContainer((currentContainer) =>
            resolveDockerContainerSelectionAfterRefresh({
              currentContainer,
              dockerContainers: result.dockerContainers,
            }),
          );
          return;
        }

        if (clearContainersOnError) {
          setDockerContainers(result.dockerContainers);
        }
      })().finally(() => {
        if (dockerOptionsInFlightLoadIdRef.current === loadId) {
          dockerOptionsInFlightLoadIdRef.current = null;
        }
        if (dockerOptionsActiveLoadIdRef.current === loadId) {
          setDockerOptionsLoading(false);
        }
      });
    },
    [platform],
  );

  useEffect(() => {
    if (!open || kind !== "ssh" || sshConfigAliasesLoaded) {
      return;
    }

    let cancelled = false;
    setSshConfigAliasesLoading(true);
    setSshConfigAliasesError("");

    void (async () => {
      try {
        const aliases = await platform.listSSHConfigAliases();
        if (cancelled) {
          return;
        }

        setSshConfigAliases(aliases);
        setSshConfigAliasesLoaded(true);
      } catch (runtimeError) {
        if (cancelled) {
          return;
        }

        setSshConfigAliases([]);
        setSshConfigAliasesLoaded(true);
        setSshConfigAliasesError(String(runtimeError));
      } finally {
        if (!cancelled) {
          setSshConfigAliasesLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [kind, open, platform, sshConfigAliasesLoaded]);

  useEffect(() => {
    if (!selectedSshConfigAlias) {
      return;
    }

    if (sshConfigAliases.some((option) => option.alias === selectedSshConfigAlias)) {
      return;
    }

    setSelectedSshConfigAlias(null);
  }, [selectedSshConfigAlias, sshConfigAliases]);

  useEffect(() => {
    if (!open || kind !== "wsl" || !isWindowsDesktop || wslOptionsLoaded) {
      return;
    }

    let cancelled = false;
    setWslOptionsLoading(true);
    setWslOptionsError("");

    void (async () => {
      try {
        const nextWslDistros = await platform.listWSLDistros();
        if (cancelled) {
          return;
        }

        setWslDistros(nextWslDistros);
        setWslOptionsLoaded(true);
      } catch (runtimeError) {
        if (cancelled) {
          return;
        }

        setWslDistros([]);
        setWslOptionsLoaded(true);
        setWslOptionsError(String(runtimeError));
      } finally {
        if (!cancelled) {
          setWslOptionsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isWindowsDesktop, kind, open, platform, wslOptionsLoaded]);

  useEffect(() => {
    if (!open || kind !== "docker" || dockerOptionsLoaded) {
      return;
    }

    refreshDockerContainers({ clearContainersOnError: true });
  }, [dockerOptionsLoaded, kind, open, refreshDockerContainers]);

  const setHost = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== host) {
      setSelectedSshConfigAlias(null);
    }
    setHostState(value);
  };

  const setPort = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== port) {
      setSelectedSshConfigAlias(null);
    }
    setPortState(value);
  };

  const setUsername = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== username) {
      setSelectedSshConfigAlias(null);
    }
    setUsernameState(value);
  };

  const setPrivateKeyPath = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== privateKeyPath) {
      setSelectedSshConfigAlias(null);
    }
    setPrivateKeyPathState(value);
  };

  const applySshConfigAlias = (aliasOption: SSHConfigAliasOption) => {
    applyingSshAliasRef.current = true;
    try {
      setSelectedSshConfigAlias(aliasOption.alias);
      const nextHost = aliasOption.host?.trim() || aliasOption.alias;
      const nextPort =
        aliasOption.port != null && Number.isFinite(aliasOption.port)
          ? String(aliasOption.port)
          : "";
      const nextUsername = aliasOption.username?.trim() ?? "";
      const nextPrivateKeyPath = aliasOption.privateKeyPath?.trim() ?? "";

      // 切换 alias 时之前只覆盖“有值字段”，缺失字段会残留上一个 alias/手动输入值。
      // 这里改为全量覆盖：所有 SSH 字段都按当前 alias 重建，缺失值统一置空，避免状态串用。
      setHostState(nextHost);
      setPortState(nextPort);
      setUsernameState(nextUsername);
      setPassword("");
      setPrivateKeyPathState(nextPrivateKeyPath);
      setPrivateKeyPassphrase("");
      setSshAuthMethod(nextPrivateKeyPath ? "privateKey" : "password");
    } finally {
      applyingSshAliasRef.current = false;
    }
  };

  const clearSelectedSshConfigAlias = () => {
    setSelectedSshConfigAlias(null);
  };

  return {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    // Docker 容器列表是运行态数据，之前只在进入 Docker 页时拉一次。
    // 下拉每次打开都通过这个回调按需刷新，避免用户看到已过期的容器列表。
    refreshDockerContainers: () => refreshDockerContainers({ clearContainersOnError: false }),
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading:
      kind === "wsl" ? wslOptionsLoading : kind === "docker" ? dockerOptionsLoading : false,
    currentRuntimeOptionsError:
      kind === "wsl" ? wslOptionsError : kind === "docker" ? dockerOptionsError : "",
  };
}
