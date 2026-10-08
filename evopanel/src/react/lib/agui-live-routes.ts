/**
 * Classification helpers for the AG-UI / evf stream event stream. The live-text
 * branch is purely a routing hint (notify snapshot store fast-path) — the real
 * state lives in ``applyStreamTurnEvent`` / ``reduceAgUiEvent``.
 *
 * Extracted from the now-removed ``live-stream-ui.ts`` so the reducer / ChatApp
 * can keep their pure routing decisions without depending on the overlay store.
 */

export function isAgUiLiveTextEvent(type: string): boolean {
  return type === 'TEXT_MESSAGE_CONTENT' || type === 'REASONING_MESSAGE_CONTENT'
}

export function isStreamTurnLiveTextEvent(type: string): boolean {
  return type === 'text_piece' || type === 'reasoning_piece'
}
