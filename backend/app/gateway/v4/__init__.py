"""H3-B: backend v4 package — projection writer, translator, routes.

Currently exposes:
- agui_to_v4_projector: raw evf payload -> v4 conversationDeltas translation.
- routes (H3-B-4): /api/v4/sessions/{sid}/... SSE endpoints.

The writer is reused from ``app.gateway.v4_demo.projection`` via the
``writer_registry`` singleton to keep one ``rows_by_id`` map + seq counter
per session across H1 demo and H3-B translator paths.
"""

from __future__ import annotations
