"""Ordered chain of FrameProcessors."""

from __future__ import annotations

from app.gateway.speech.runtime.frames import Frame
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor


class Pipeline(FrameProcessor):
    """Composite processor: pushes into the first station; output leaves the last."""

    def __init__(self, processors: list[FrameProcessor], name: str = "Pipeline") -> None:
        super().__init__(name=name)
        if not processors:
            raise ValueError("Pipeline requires at least one processor")
        self._processors = list(processors)
        for i in range(len(self._processors) - 1):
            self._processors[i].link(self._processors[i + 1])
        # Last processor's downstream goes to pipeline's push_downstream via worker hook
        self._source = self._processors[0]
        self._sink = self._processors[-1]

    @property
    def processors(self) -> list[FrameProcessor]:
        return list(self._processors)

    def set_worker(self, worker) -> None:  # noqa: ANN001
        super().set_worker(worker)
        for p in self._processors:
            p.set_worker(worker)
        # Re-bind sink output through pipeline so worker.on_pipeline_output fires
        sink = self._sink

        async def _sink_push_downstream(frame: Frame) -> None:
            await self.push_downstream(frame)

        async def _source_push_upstream(frame: Frame) -> None:
            await self.push_upstream(frame)

        sink.push_downstream = _sink_push_downstream  # type: ignore[method-assign]
        self._source.push_upstream = _source_push_upstream  # type: ignore[method-assign]

    async def start(self) -> None:
        await super().start()
        for p in self._processors:
            await p.start()

    async def stop(self) -> None:
        for p in reversed(self._processors):
            await p.stop()
        await super().stop()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction == FrameDirection.DOWNSTREAM:
            await self._source.queue_frame(frame, FrameDirection.DOWNSTREAM)
        else:
            await self._sink.queue_frame(frame, FrameDirection.UPSTREAM)

    async def queue_frame(
        self,
        frame: Frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        # Enter at the appropriate end without buffering in the composite inbox
        if direction == FrameDirection.DOWNSTREAM:
            await self._source.queue_frame(frame, direction)
        else:
            await self._sink.queue_frame(frame, direction)

    async def on_interruption(self, frame: Frame) -> None:
        # Individual processors already receive InterruptionFrame via worker broadcast
        pass
