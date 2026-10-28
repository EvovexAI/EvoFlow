import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/tauri-api.js";
import { kbActivityLabel, kbActivityRelativeTime } from "./knowledge-owned-activity.js";
import { KB_UI_PLACEHOLDERS } from "./knowledge-owned-placeholders.js";

export function parseMarkdownHeadings(markdown) {
  const src = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (!m) continue;
    const text = m[2].replace(/#+\s*$/, "").trim();
    if (!text) continue;
    out.push({
      level: m[1].length,
      text,
      key: `${m[1].length}-${text}-${out.length}`,
    });
  }
  return out;
}

export function parseHeroTitle(title) {
  const raw = String(title || "").trim() || "未命名文档";
  const colon = raw.match(/^([^：:]{1,16})[：:]\s*(.+)$/);
  if (!colon) {
    return { eyebrow: "Knowledge Doc", title: raw, subtitle: "" };
  }
  const eyebrow = colon[1].trim();
  const rest = colon[2].trim();
  const sub = rest.match(/^(.+?)((?:每周|每日|每月|每季|自动|一键|实时).+)$/);
  if (sub) {
    return { eyebrow, title: sub[1].trim(), subtitle: sub[2].trim() };
  }
  if (rest.length > 14) {
    const cut = rest.search(/[\s，,·]/);
    if (cut > 4 && cut < rest.length - 2) {
      return { eyebrow, title: rest.slice(0, cut).trim(), subtitle: rest.slice(cut + 1).trim() };
    }
  }
  return { eyebrow, title: rest, subtitle: "" };
}

export function extractHeroDescription(markdown, summary) {
  const s = String(summary || "").trim();
  if (s) return s.slice(0, 160);
  const src = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^```/.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !t || /^#{1,6}\s/.test(t) || /^[-*|>]/.test(t) || /^\d+\.\s/.test(t)) continue;
    return t.replace(/[*_`]/g, "").slice(0, 160);
  }
  return "";
}

export function estimateDocStats(markdown, doc) {
  const text = String(markdown || "");
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`\[\]()!-]/g, " ")
    .replace(/\s+/g, "");
  const chars = plain.length;
  const words = Math.max(1, Math.round(chars / 2.2));
  const minutes = Math.max(1, Math.ceil(chars / 450));
  const updated = doc?.updatedAt ? String(doc.updatedAt).replace("T", " ").slice(0, 19) : "—";
  const source =
    doc?.source === "parsed"
      ? "解析正文"
      : doc?.source === "summary"
        ? "摘要"
        : doc?.source === "raw"
          ? "原文"
          : doc?.fileName
            ? "本地文件"
            : "—";
  return { chars, words, minutes, updated, source };
}

/**
 * Compute a doc-level "knowledge health" score and a list of plain-language
 * hints from the real document + job state.
 *
 * Replaces the old hard-coded `KB_UI_PLACEHOLDERS.detailHealthScore` (always 92)
 * which was inconsistent with the live `jobStats` banner ("失败 432" etc.).
 *
 * The score is intentionally a per-doc snapshot, not a KB aggregate: this card
 * is the right-side rail of one document. The hints surface concrete actions
 * the user can take (reindex, refresh, view errors) when something is off.
 */
export function computeDocHealth(doc, jobStats) {
  const hints = [];
  const parseStatus = String(doc?.parseStatus || "").toLowerCase();
  const indexStatus = String(doc?.indexStatus || "").toLowerCase();
  const vectorStatus = String(doc?.vectorStatus || "").toLowerCase();
  const keywordStatus = String(doc?.keywordStatus || "").toLowerCase();
  const chunkCount = Number(doc?.chunkCount || 0);
  const docError = String(doc?.errorMessage || doc?.indexError || "").trim();

  const errorJobs = Number(jobStats?.error || 0);
  const pendingJobs = Number(jobStats?.pendingDocs || 0);
  const runningJobs = Number((jobStats?.running || 0) + (jobStats?.queued || 0));

  let score = 100;
  let label = "健康";

  // Hard failure: the doc itself failed parse / index.
  if (parseStatus === "failed" || indexStatus === "failed" || vectorStatus === "failed") {
    score -= 55;
    label = "需修复";
    hints.push({
      kind: "err",
      text: docError
        ? `文档解析失败：${docError.slice(0, 80)}`
        : "文档解析失败，建议在文档列表里点「重新索引」",
    });
  } else if (parseStatus === "processing" || parseStatus === "pending") {
    score -= 25;
    label = "索引中";
    hints.push({ kind: "warn", text: "文档正在解析，索引完成后问答可命中" });
  } else if (parseStatus === "completed" && chunkCount === 0) {
    score -= 30;
    label = "需重新索引";
    hints.push({ kind: "err", text: "解析完成但没有生成切片，建议重建索引" });
  } else if (parseStatus === "completed" || parseStatus === "") {
    // Per-channel checks only meaningful when the doc is otherwise ready.
    if (vectorStatus === "degraded" || vectorStatus === "partial") {
      score -= 15;
      label = "部分索引";
      hints.push({ kind: "warn", text: "向量索引覆盖不全，部分检索会降级" });
    } else if (vectorStatus === "failed" && keywordStatus !== "ready") {
      score -= 25;
      label = "需修复";
      hints.push({ kind: "err", text: "向量与关键词索引都失败，问答无法命中" });
    }
  }

  // KB-level job queue: errors are real (no longer hard-coded to 0).
  if (errorJobs > 0) {
    score -= Math.min(30, Math.round(Math.log10(errorJobs + 1) * 12) + (errorJobs > 0 ? 8 : 0));
    if (label === "健康") label = "部分失败";
    hints.push({
      kind: "err",
      text: `知识库有 ${errorJobs} 个失败任务，可在「处理进度」里查看`,
    });
  }
  if (runningJobs > 0 || pendingJobs > 0) {
    score -= Math.min(10, runningJobs + pendingJobs);
    if (label === "健康") label = "索引中";
    hints.push({
      kind: "warn",
      text: `当前还有 ${runningJobs} 个任务在跑、${pendingJobs} 篇待解析`,
    });
  }

  // Healthy branches.
  if (hints.length === 0) {
    hints.push({ kind: "ok", text: `文档已成功索引（${chunkCount} 个切片）` });
    hints.push({ kind: "ok", text: "向量与关键词索引都在线" });
  } else {
    // Always append a forward-looking positive hint when state isn't fully broken.
    if (score >= 70) {
      hints.push({ kind: "ok", text: "可正常检索与问答" });
    } else {
      hints.push({ kind: "warn", text: "修复后建议再跑一次回归检索" });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const tone = score >= 85 ? "ok" : score >= 60 ? "warn" : "err";
  return { score, label, tone, hints: hints.slice(0, 3) };
}

export function DocumentHero({ title, content, summary }) {
  const meta = useMemo(() => parseHeroTitle(title), [title]);
  const desc = useMemo(
    () => extractHeroDescription(content, summary),
    [content, summary]
  );

  return (
    <div className="ko-doc-hero" data-testid="ko-doc-hero">
      <div className="ko-doc-hero__glow" aria-hidden="true" />
      <div className="ko-doc-hero__copy">
        <p className="ko-doc-hero__eyebrow">{meta.eyebrow}</p>
        <h2 className="ko-doc-hero__title">{meta.title}</h2>
        {meta.subtitle ? <p className="ko-doc-hero__subtitle">{meta.subtitle}</p> : null}
        {desc ? <p className="ko-doc-hero__desc">{desc}</p> : null}
      </div>
      <div className="ko-doc-hero__art" aria-hidden="true">
        <svg className="ko-doc-hero__svg" viewBox="0 0 320 220" fill="none">
          <defs>
            <linearGradient id="koHeroCard" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#4f7cff" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.25" />
            </linearGradient>
            <linearGradient id="koHeroBar" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#4f7cff" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.85" />
            </linearGradient>
            <linearGradient id="koHeroLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#8b5cf6" />
            </linearGradient>
            <filter id="koHeroSoft" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="6" />
            </filter>
          </defs>
          {/* floating soft blobs — not solid rects */}
          <ellipse cx="210" cy="70" rx="88" ry="48" fill="#4f7cff" opacity="0.12" filter="url(#koHeroSoft)" />
          <ellipse cx="250" cy="150" rx="70" ry="40" fill="#8b5cf6" opacity="0.14" filter="url(#koHeroSoft)" />
          {/* 3D-ish data card */}
          <g transform="translate(148 28) skewY(-6)">
            <path
              d="M0 18 C0 8 8 0 18 0 H150 C160 0 168 8 168 18 V98 C168 108 160 116 150 116 H18 C8 116 0 108 0 98 Z"
              fill="url(#koHeroCard)"
              stroke="rgba(125,145,255,0.35)"
              strokeWidth="1"
            />
            <path d="M18 28 H150" stroke="rgba(255,255,255,0.2)" strokeWidth="1.2" />
            <path d="M18 44 H120" stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
            <path d="M18 58 H138" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
            <circle cx="34" cy="86" r="7" fill="#22d3ee" opacity="0.85" />
            <circle cx="58" cy="86" r="7" fill="#4f7cff" opacity="0.75" />
            <circle cx="82" cy="86" r="7" fill="#8b5cf6" opacity="0.7" />
          </g>
          {/* bar chart */}
          <g transform="translate(36 108)">
            <path d="M0 72 H120" stroke="rgba(125,145,255,0.25)" strokeWidth="1" />
            <rect x="8" y="38" width="14" height="34" rx="4" fill="url(#koHeroBar)" />
            <rect x="32" y="22" width="14" height="50" rx="4" fill="url(#koHeroBar)" opacity="0.85" />
            <rect x="56" y="30" width="14" height="42" rx="4" fill="url(#koHeroBar)" opacity="0.7" />
            <rect x="80" y="12" width="14" height="60" rx="4" fill="url(#koHeroBar)" />
            <rect x="104" y="26" width="14" height="46" rx="4" fill="url(#koHeroBar)" opacity="0.8" />
          </g>
          {/* line chart */}
          <path
            d="M40 96 C70 88 90 70 120 74 C150 78 170 52 200 58 C220 62 240 48 268 42"
            stroke="url(#koHeroLine)"
            strokeWidth="2.2"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M40 96 C70 88 90 70 120 74 C150 78 170 52 200 58 C220 62 240 48 268 42 V110 H40 Z"
            fill="url(#koHeroLine)"
            opacity="0.08"
          />
          {/* data nodes */}
          <circle cx="120" cy="74" r="4.5" fill="#22d3ee" />
          <circle cx="200" cy="58" r="4.5" fill="#8b5cf6" />
          <circle cx="268" cy="42" r="5" fill="#4f7cff" />
          <circle cx="120" cy="74" r="9" stroke="#22d3ee" strokeOpacity="0.35" fill="none" />
          <circle cx="268" cy="42" r="11" stroke="#4f7cff" strokeOpacity="0.3" fill="none" />
        </svg>
      </div>
    </div>
  );
}

export function DocumentToc({ headings, activeText, onJump }) {
  if (!headings?.length) {
    return <div className="ko-toc-empty">当前文档暂无标题</div>;
  }
  return (
    <nav className="ko-toc" aria-label="文档目录">
      <p className="ko-toc__label">文档目录</p>
      <ul className="ko-toc__list">
        {headings.map((h) => (
          <li
            className={`ko-toc__item is-h${h.level}${activeText === h.text ? " is-active" : ""}`}
            key={h.key}
          >
            <button onClick={() => onJump(h.text)} type="button">
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Enhance rendered markdown preview: workflow steps, code lang labels, heading ids. */
export function useReaderMarkdownEnhance(containerRef, depKey) {
  useEffect(() => {
    let cancelled = false;
    let tries = 0;

    const enhance = () => {
      if (cancelled) return;
      const root =
        containerRef.current?.querySelector?.(
          ".markdown-body, .md-doc-preview, [data-markdown-preview], .ko-v4-md__inner",
        ) || containerRef.current;
      if (!root || !root.querySelector?.("h1, h2, h3, [data-streamdown^='heading']")) {
        if (tries++ < 20) {
          window.setTimeout(enhance, 50);
        }
        return;
      }

      root.querySelectorAll("h1, h2, h3").forEach((el, idx) => {
        const text = (el.textContent || "").trim();
        if (!text) return;
        if (!el.id) {
          el.id = `ko-h-${idx}-${encodeURIComponent(text).slice(0, 48)}`;
        }
        el.setAttribute("data-ko-heading", text);
      });

      root.querySelectorAll("h2").forEach((h2) => {
        const title = (h2.textContent || "").trim();
        let sib = h2.nextElementSibling;
        while (sib && !/^H[1-6]$/.test(sib.tagName)) {
          if (/场景/.test(title)) {
            if (sib.tagName === "BLOCKQUOTE" || sib.tagName === "P") {
              sib.classList.add("ko-md-callout");
            }
          }
          if (/操作步骤|步骤/.test(title) && sib.tagName === "OL") {
            sib.classList.add("ko-workflow-steps");
            Array.from(sib.children).forEach((li, i) => {
              li.classList.add("ko-workflow-step");
              if (!li.querySelector(":scope > .ko-workflow-badge")) {
                const badge = document.createElement("span");
                badge.className = "ko-workflow-badge";
                badge.setAttribute("aria-hidden", "true");
                badge.textContent = String(i + 1);
                li.insertBefore(badge, li.firstChild);
              }
            });
          }
          sib = sib.nextElementSibling;
        }
      });

      root.querySelectorAll("blockquote").forEach((bq) => {
        bq.classList.add("ko-md-callout");
      });

      root.querySelectorAll("pre.md-code-block[data-lang]").forEach((pre) => {
        if (pre.querySelector(".ko-code-lang")) return;
        const lang = pre.getAttribute("data-lang");
        if (!lang) return;
        const label = document.createElement("span");
        label.className = "ko-code-lang";
        label.textContent = lang;
        pre.insertBefore(label, pre.firstChild);
      });
    };

    enhance();
    let debounce = 0;
    const mo = new MutationObserver(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(enhance, 40);
    });
    if (containerRef.current) {
      mo.observe(containerRef.current, { childList: true, subtree: true });
    }
    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
      mo.disconnect();
    };
  }, [containerRef, depKey]);
}

export function scrollToHeading(container, headingText) {
  const root =
    container?.querySelector?.(
      ".markdown-body, .md-doc-preview, [data-markdown-preview], .ko-v4-md__inner",
    ) || container;
  if (!root) return;
  const nodes = root.querySelectorAll("h1, h2, h3");
  for (const el of nodes) {
    if ((el.textContent || "").trim() === headingText) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
}

function CircularGauge({ value = 92, label = "健康" }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const r = 36;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - v / 100);
  return (
    <div className="ko-gauge">
      <svg viewBox="0 0 96 96" className="ko-gauge__svg" aria-hidden="true">
        <circle cx="48" cy="48" r={r} className="ko-gauge__track" />
        <circle
          cx="48"
          cy="48"
          r={r}
          className="ko-gauge__value"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="ko-gauge__center">
        <strong>{v}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function chunkKindLabel(kind) {
  const k = String(kind || "text");
  if (k === "table") return "表格";
  if (k === "mixed") return "混合";
  return "文本";
}

/** Inspect parse/index chunks for one document (content + embedding flags). */
export function DocumentChunksPanel({
  open,
  docId,
  docLabel = "",
  onClose,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("all"); // all | embedded | pending

  useEffect(() => {
    if (!open || !docId) {
      setItems([]);
      setError("");
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const res = await api.listOwnedKnowledgeChunks(docId);
        if (cancelled) return;
        setItems(Array.isArray(res?.items) ? res.items : []);
      } catch (e) {
        if (cancelled) return;
        setItems([]);
        setError(e?.message || "加载分块失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, docId]);

  if (!open) return null;

  const embedded = items.filter((c) => c.hasEmbedding).length;
  const enabled = items.filter((c) => c.enabled).length;
  const visible = items.filter((c) => {
    if (filter === "embedded") return Boolean(c.hasEmbedding);
    if (filter === "pending") return !c.hasEmbedding;
    return true;
  });

  return (
    <div
      className="ko-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
      role="presentation"
    >
      <div
        className="ko-modal ko-chunks-panel"
        data-testid="ko-chunks-panel"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ko-chunks-title"
      >
        <header className="ko-chunks-panel__head">
          <div>
            <h2 id="ko-chunks-title">分块详情</h2>
            <p className="ko-modal__hint" title={docLabel}>
              {docLabel || docId}
            </p>
          </div>
          <button className="ko-icon-btn" onClick={onClose} title="关闭" type="button">
            ×
          </button>
        </header>

        <div className="ko-chunks-panel__stats" aria-label="分块统计">
          <div>
            <strong>{items.length}</strong>
            <span>总分块</span>
          </div>
          <div>
            <strong>{embedded}</strong>
            <span>已向量化</span>
          </div>
          <div>
            <strong>{enabled}</strong>
            <span>已启用检索</span>
          </div>
          <div>
            <strong>{Math.max(0, items.length - embedded)}</strong>
            <span>待向量</span>
          </div>
        </div>

        <div className="ko-chunks-panel__filters" role="tablist" aria-label="筛选分块">
          {[
            { id: "all", label: "全部" },
            { id: "embedded", label: "已向量化" },
            { id: "pending", label: "未向量化" },
          ].map((f) => (
            <button
              key={f.id}
              className={`ko-chunks-panel__filter${filter === f.id ? " is-active" : ""}`}
              onClick={() => setFilter(f.id)}
              type="button"
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="ko-chunks-panel__list">
          {loading ? (
            <p className="ko-meta">加载分块…</p>
          ) : error ? (
            <p className="ko-modal__hint is-warn">{error}</p>
          ) : !visible.length ? (
            <p className="ko-meta">
              {items.length ? "当前筛选下没有分块" : "该文档还没有分块（可能尚未完成索引）"}
            </p>
          ) : (
            visible.map((chunk, idx) => {
              const id = String(chunk.id || idx);
              return (
                <article
                  className={`ko-chunk-card is-open${chunk.hasEmbedding ? " is-embedded" : ""}`}
                  key={id}
                >
                  <div className="ko-chunk-card__head">
                    <span className="ko-chunk-card__ord">#{Number(chunk.ordinal) + 1 || idx + 1}</span>
                    <span className="ko-chunk-card__kind">{chunkKindLabel(chunk.chunkKind)}</span>
                    <span
                      className={`ko-chunk-card__vec${chunk.hasEmbedding ? " is-on" : ""}`}
                      title={
                        chunk.hasEmbedding
                          ? `已向量化${chunk.embeddingDim ? ` · ${chunk.embeddingDim} 维` : ""}`
                          : "尚未向量化"
                      }
                    >
                      {chunk.hasEmbedding ? "向量 ✓" : "无向量"}
                    </span>
                    <span
                      className={`ko-chunk-card__enabled${chunk.enabled ? " is-on" : ""}`}
                      title={chunk.enabled ? "已启用检索" : "未启用（索引未完成或失败）"}
                    >
                      {chunk.enabled ? "可检索" : "未启用"}
                    </span>
                  </div>
                  <div className="ko-chunk-card__body">
                    {chunk.headingPath ? (
                      <p className="ko-chunk-card__meta">
                        标题路径：<code>{chunk.headingPath}</code>
                      </p>
                    ) : null}
                    {chunk.contextHeader ? (
                      <p className="ko-chunk-card__meta">
                        上下文头：<code>{chunk.contextHeader}</code>
                      </p>
                    ) : null}
                    <pre className="ko-chunk-card__content">{chunk.content || "（空）"}</pre>
                  </div>
                </article>
              );
            })
          )}
        </div>

        <div className="ko-modal__actions">
          <button className="ko-btn" onClick={onClose} type="button">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export function KnowledgeRailCards({
  doc,
  related,
  summaryBusy,
  summaryEnabled = false,
  onGenerate,
  onForce,
  onOpenRelated,
  docLinks,
  contentText,
  jobStats,
  kbId,
  onOpenChunks,
}) {
  const [activities, setActivities] = useState([]);
  const effectiveKbId = kbId || doc?.kbId || "";
  const docId = doc?.id || "";

  useEffect(() => {
    if (!effectiveKbId) {
      setActivities([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listOwnedKnowledgeActivities({
          kbId: effectiveKbId,
          docId: docId || undefined,
          limit: 12,
        });
        if (!cancelled) setActivities(res.items || []);
      } catch {
        if (!cancelled) setActivities([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveKbId, docId, doc?.updatedAt, doc?.summaryStatus]);

  if (!doc) return null;
  const stats = estimateDocStats(contentText || doc.content || "", doc);
  const healthInfo = computeDocHealth(doc, jobStats);
  const text = String(doc.summaryText || "").trim();
  const status = String(doc.summaryStatus || "");
  const busy = summaryBusy || status === "pending" || status === "processing";
  const tags = Array.isArray(doc.tags) ? doc.tags : [];
  const backlinks = docLinks?.inLinks || [];
  const outLinks = docLinks?.outLinks || [];
  const relatedMerged = [];
  const seen = new Set();
  for (const r of related || []) {
    if (!r?.docId || seen.has(r.docId)) continue;
    seen.add(r.docId);
    relatedMerged.push({ id: r.docId, title: r.title, kind: "相关" });
  }
  for (const r of backlinks) {
    if (!r?.docId || seen.has(r.docId)) continue;
    seen.add(r.docId);
    relatedMerged.push({ id: r.docId, title: r.title, kind: "反向" });
  }
  for (const r of outLinks) {
    if (!r?.docId || seen.has(r.docId)) continue;
    seen.add(r.docId);
    relatedMerged.push({ id: r.docId, title: r.title || r.targetRaw, kind: "出链" });
  }

  return (
    <div className="ko-rail-stack" data-testid="ko-overview-rail-stack">
      <section className={`ko-rail-card ko-rail-card--health is-${healthInfo.tone || "ok"}`}>
        <header className="ko-rail-card__head">
          <h3>知识健康度</h3>
        </header>
        <CircularGauge value={healthInfo.score} label={healthInfo.label} />
        <ul className="ko-rail-hints">
          {healthInfo.hints.map((h, idx) => (
            <li
              key={`${h.kind}-${idx}`}
              className={`ko-rail-hint is-${h.kind}`}
            >
              {h.text}
            </li>
          ))}
        </ul>
      </section>

      <section className="ko-rail-card">
        <header className="ko-rail-card__head">
          <h3>文档信息</h3>
        </header>
        <dl className="ko-rail-meta">
          <div>
            <dt>文件</dt>
            <dd className="ko-rail-meta__file" title={doc?.fileName || ""}>
              {doc?.fileName || "—"}
            </dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{stats.updated}</dd>
          </div>
          <div>
            <dt>字数</dt>
            <dd>{stats.chars.toLocaleString("zh-CN")}</dd>
          </div>
          <div>
            <dt>分块</dt>
            <dd>
              {Number(doc?.chunkCount || 0).toLocaleString("zh-CN")}
              {onOpenChunks ? (
                <button className="ko-link-btn" onClick={onOpenChunks} type="button">
                  查看
                </button>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>阅读时间</dt>
            <dd>约 {stats.minutes} 分钟</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{stats.source}</dd>
          </div>
        </dl>
        {tags.length ? (
          <div className="ko-tags">
            {tags.map((t) => (
              <span className="ko-tag" key={t}>
                #{t}
              </span>
            ))}
          </div>
        ) : null}
        {text ? (
          <p className="ko-rail-summary">{text}</p>
        ) : busy ? (
          <p className="ko-meta">摘要生成中…</p>
        ) : (
          <p className="ko-meta">
            {summaryEnabled ? "暂无摘要" : "暂无摘要（自动生成已关闭）"}
          </p>
        )}
        {text ? (
          <button className="ko-btn ghost" disabled={busy} onClick={onForce} type="button">
            重新生成摘要
          </button>
        ) : (
          <button className="ko-btn ghost" disabled={busy} onClick={onGenerate} type="button">
            {busy ? "生成中…" : "手动生成摘要"}
          </button>
        )}
      </section>

      <section className="ko-rail-card" data-testid="ko-rail-activity">
        <header className="ko-rail-card__head">
          <h3>操作轨迹</h3>
        </header>
        {activities.length ? (
          <ul className="ko-activity-list">
            {activities.map((a) => (
              <li key={a.id}>
                <div className="ko-activity-list__row">
                  <span className="ko-activity-list__action">{kbActivityLabel(a.action)}</span>
                  <span className="ko-activity-list__title">{a.title || "—"}</span>
                  <span className="ko-activity-list__time">{kbActivityRelativeTime(a.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ko-meta">{docId ? "该文档暂无操作记录" : "本库暂无操作记录"}</p>
        )}
      </section>

      <section className="ko-rail-card">
        <header className="ko-rail-card__head">
          <h3>相关知识</h3>
        </header>
        {relatedMerged.length ? (
          <ul className="ko-rail-related">
            {relatedMerged.slice(0, 12).map((r) => (
              <li key={`${r.kind}-${r.id}`}>
                <button onClick={() => onOpenRelated?.(r.id)} type="button">
                  <span className="ko-rail-related__kind">{r.kind}</span>
                  <span className="ko-rail-related__title">{r.title}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ko-meta">暂无关联文档</p>
        )}
      </section>
    </div>
  );
}
