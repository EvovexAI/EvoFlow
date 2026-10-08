/*
 * Derived from vercel/ai-elements (packages/elements/src/connection.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
import type { ConnectionLineComponent } from "@xyflow/react";

const HALF = 0.5;

export const Connection: ConnectionLineComponent = ({ fromX, fromY, toX, toY }) => (
  <g>
    <path
      className="animated"
      d={`M${fromX},${fromY} C ${fromX + (toX - fromX) * HALF},${fromY} ${fromX + (toX - fromX) * HALF},${toY} ${toX},${toY}`}
      fill="none"
      stroke="var(--color-ring)"
      strokeWidth={1}
    />
    <circle cx={toX} cy={toY} fill="#fff" r={3} stroke="var(--color-ring)" strokeWidth={1} />
  </g>
);
