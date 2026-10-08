import { createContext } from "react";
import type { TrajectoryVisualRole } from "@/ModelTrajectoryRoleStyles.js";

export interface TrajectoryExpansionCommand {
  expanded: boolean;
  version: number;
}

export type TrajectoryExpansionCommands = Record<TrajectoryVisualRole, TrajectoryExpansionCommand>;

export const TRAJECTORY_EXPANSION_KINDS: readonly TrajectoryVisualRole[] = [
  "system",
  "user",
  "reasoning",
  "assistant",
  "tool-call",
  "tool-result",
];

export function createTrajectoryExpansionCommands(): TrajectoryExpansionCommands {
  return Object.fromEntries(
    TRAJECTORY_EXPANSION_KINDS.map((kind) => [kind, { expanded: true, version: 0 }]),
  ) as TrajectoryExpansionCommands;
}

export const TrajectoryExpansionCommandContext = createContext<TrajectoryExpansionCommands | null>(
  null,
);

export interface TrajectoryExpansionOverride {
  open: boolean;
  commandVersion: number;
}

interface TrajectoryExpansionRegistry {
  overrides: ReadonlyMap<string, TrajectoryExpansionOverride>;
  setOverride: (key: string, override: TrajectoryExpansionOverride) => void;
}

export const TrajectoryExpansionRegistryContext = createContext<TrajectoryExpansionRegistry | null>(
  null,
);
