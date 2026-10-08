/**
 * H1 demo: re-export verbatim ZCode v4 protocol types.
 *
 * The historical local types kept only the minimum row schema; H2.5 migrated the
 * gateway endpoints to the same shape, so a thin re-export is enough.
 */

export * from '../v4/protocol/types'

export type { ProjectionState, ProjectionSnapshot, ProjectionStatus } from '../v4/conversationProjectionStore'
