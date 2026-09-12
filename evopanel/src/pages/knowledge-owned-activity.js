/** Centralized activity action labels + relative time for Owned KB trail UI. */

export const KB_ACTIVITY_LABELS = {
  "base.create": "新建知识库",
  "base.delete": "删除知识库",
  "doc.upload": "上传文档",
  "doc.manual": "手写笔记",
  "doc.save": "保存文档",
  "doc.delete": "删除文档",
  "doc.move": "移动文档",
  "folder.create": "新建文件夹",
  "folder.rename": "重命名文件夹",
  "folder.delete": "删除文件夹",
  "folder.move": "移动文件夹",
  "import.folder": "导入文件夹",
  "import.vault": "导入 Vault",
  "sync.resync": "再同步",
  "summary.generate": "生成摘要",
  "wiki.rebuild": "重建 Wiki",
  "kg.rebuild": "重建图谱",
  ask: "问 AI",
  search: "检索",
};

export function kbActivityLabel(action) {
  return KB_ACTIVITY_LABELS[action] || String(action || "操作");
}

export function kbActivityRelativeTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso).slice(0, 16);
  const diff = Math.max(0, Date.now() - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(iso).slice(0, 16);
  }
}
