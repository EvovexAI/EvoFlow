import type { IFileService } from "@zcode/services";
import { WORKSPACE_FILE_ENTRIES_CHUNK_SIZE } from "@zcode/shared/workspaceFileEntriesCodec";

/**
 * 分块拉取 workspace 文件索引的列式 packed 字符串。
 * 单条 RPC 大消息（65MB）在 renderer 接收端的分帧重组是 4.6-6.3s 主线程长任务，
 * 输入会冻结；分块（~4MB/块）+ 块间 setTimeout(0) 让出事件循环后，主线程每次
 * 只处理一小块（~50ms），键入事件始终能插队。整体耗时不变，但 UI 永不冻结。
 */
export async function fetchWorkspaceFileEntriesPacked(
  fileService: Pick<IFileService, "listWorkspaceFilesLength" | "listWorkspaceFilesRange">,
  rootPath: string,
): Promise<string> {
  const totalLength = await fileService.listWorkspaceFilesLength({ rootPath });
  let packed = "";
  for (let offset = 0; offset < totalLength; offset += WORKSPACE_FILE_ENTRIES_CHUNK_SIZE) {
    const chunk = await fileService.listWorkspaceFilesRange({
      rootPath,
      offset,
      length: WORKSPACE_FILE_ENTRIES_CHUNK_SIZE,
    });
    packed += chunk;
    // 块间让出：处理下一块前先放行排队的输入/渲染任务。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return packed;
}
