import React from "react";

/**
 * Hub-level switch: owned KB is primary; Obsidian vaults are legacy/transition only.
 */
export function KnowledgeSourceTabs({ active }) {
  const isObsidian = active === "obsidian";
  const isOwned = active === "owned";
  return (
    <nav className="kb-source-tabs" aria-label="知识库类型" data-testid="kb-source-tabs">
      <a
        className={`kb-source-tabs__item${isOwned ? " is-active" : ""}`}
        data-testid="kb-tab-owned"
        href="#/knowledge/owned"
      >
        知识库
      </a>
      <a
        className={`kb-source-tabs__item kb-source-tabs__item--secondary${isObsidian ? " is-active" : ""}`}
        data-testid="kb-tab-obsidian"
        href="#/knowledge/vaults"
        title="遗留：外部挂载 Obsidian，新内容请用知识库"
      >
        Obsidian（遗留）
      </a>
    </nav>
  );
}
