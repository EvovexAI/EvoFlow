import React from "react";

/**
 * Single-source knowledge — owned KB only. The Obsidian vault tab has been
 * removed; new content should be added directly to the owned KB.
 */
export function KnowledgeSourceTabs({ active }) {
  return (
    <nav className="kb-source-tabs" aria-label="知识库" data-testid="kb-source-tabs">
      <a
        className="kb-source-tabs__item is-active"
        data-testid="kb-tab-owned"
        href="#/knowledge/owned"
      >
        知识库
      </a>
    </nav>
  );
}
