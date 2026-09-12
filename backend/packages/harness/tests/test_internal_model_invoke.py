"""Internal auxiliary model calls must not pass streaming= into the OpenAI SDK."""

from __future__ import annotations

from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model, invoke_internal_chat_model


class _StreamingModel:
    streaming = True

    def __init__(self) -> None:
        self.bound_streaming: bool | None = None

    def bind(self, **kwargs):
        self.bound_streaming = kwargs.get("streaming")
        return _BoundModel(self)

    def invoke(self, messages, **kwargs):
        if "streaming" in kwargs:
            raise TypeError("AsyncCompletions.create() got an unexpected keyword argument 'streaming'")
        return {"content": "ok"}

    async def ainvoke(self, messages, **kwargs):
        if "streaming" in kwargs:
            raise TypeError("AsyncCompletions.create() got an unexpected keyword argument 'streaming'")
        return {"content": "ok"}


class _BoundModel:
    def __init__(self, parent: _StreamingModel) -> None:
        self._parent = parent

    def invoke(self, messages, **kwargs):
        return self._parent.invoke(messages, **kwargs)

    async def ainvoke(self, messages, **kwargs):
        return await self._parent.ainvoke(messages, **kwargs)


def test_invoke_internal_binds_non_streaming():
    model = _StreamingModel()
    out = invoke_internal_chat_model(model, [{"role": "user", "content": "hi"}])
    assert out["content"] == "ok"
    assert model.bound_streaming is False


def test_ainvoke_internal_binds_non_streaming():
    import asyncio

    model = _StreamingModel()
    out = asyncio.run(ainvoke_internal_chat_model(model, [{"role": "user", "content": "hi"}]))
    assert out["content"] == "ok"
    assert model.bound_streaming is False
