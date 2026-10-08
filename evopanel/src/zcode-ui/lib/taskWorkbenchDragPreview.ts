interface TaskWorkbenchDragPreviewParams {
  clientX: number;
  clientY: number;
  dataTransfer: Pick<DataTransfer, "setDragImage">;
  source: HTMLElement;
}

function createTaskWorkbenchDragPreview({
  clientX,
  clientY,
  dataTransfer,
  source,
}: TaskWorkbenchDragPreviewParams): () => void {
  const document = source.ownerDocument;
  const sourceRect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  preview.dataset.taskWorkbenchDragPreview = "true";
  // 默认 drag preview 的透明底会让 Project task 在浮层中缺少边界；
  // 保留原行内容，只补 Grouped drag overlay 已使用的 surface 样式。
  preview.classList.add("border", "border-border", "bg-background", "shadow-lg");
  preview.style.position = "fixed";
  preview.style.left = "-10000px";
  preview.style.top = "-10000px";
  preview.style.pointerEvents = "none";
  preview.style.width = `${sourceRect.width}px`;
  document.body.append(preview);

  dataTransfer.setDragImage(
    preview,
    Math.max(0, Math.min(clientX - sourceRect.left, sourceRect.width)),
    Math.max(0, Math.min(clientY - sourceRect.top, sourceRect.height)),
  );

  return () => preview.remove();
}

export { createTaskWorkbenchDragPreview };
