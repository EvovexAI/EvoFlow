"""``app.gateway.v4_demo`` H1 demo。

最小端到端：一个 session 一条 user 消息触发一段 assistant streaming。
展示 v4 投影 (``snapshot`` + ``deltas`` ``row.appended``/``row.upserted``)。
完整 v4 spec 见 ``EvoFlow/docs/protocol-evolution-spec.md``。
"""
