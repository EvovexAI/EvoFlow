#!/usr/bin/env python3
"""Generate evopanel/src/lib/platform-action-labels.js from platform_actions registry."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend" / "packages" / "harness"))

from evoflow.admin.platform_actions import DOMAIN_GUIDES, _build_registry  # noqa: E402

OUT = ROOT / "evopanel" / "src" / "lib" / "platform-action-labels.js"

OP_FALLBACK = {
    "list": "列出",
    "get": "查看",
    "create": "创建",
    "update": "更新",
    "delete": "删除",
    "search": "检索",
    "enable": "启停",
    "install": "安装",
    "uninstall": "卸载",
    "run": "运行",
    "stop": "停止",
    "resume": "恢复",
    "publish": "发布",
    "hire": "雇佣",
    "pause": "暂停",
    "wake": "唤醒",
    "approve": "批准",
    "reject": "拒绝",
    "catalog": "查看目录",
    "help": "查看说明",
    "test": "测通",
    "patch": "更新",
    "ingest": "写入",
    "dispatch": "派发",
    "progress": "更新进度",
}


def _js_str(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main() -> None:
    reg = _build_registry()
    domains = {k: str(v.get("title") or k) for k, v in DOMAIN_GUIDES.items()}
    actions = {a.name: a.summary for a in reg.values()}

    lines: list[str] = [
        "/**",
        " * platform(action=domain.op) 展示文案枚举。",
        " * 与 backend ``evoflow.admin.platform_actions`` 注册表 DOMAIN_GUIDES / summary 对齐。",
        " * 重新生成：python evopanel/scripts/gen-platform-action-labels.py",
        " */",
        "",
        "/** @type {Record<string, string>} */",
        "export const PLATFORM_DOMAIN_ZH = {",
    ]
    for k in sorted(domains):
        lines.append(f"  {k}: {_js_str(domains[k])},")
    lines += [
        "}",
        "",
        "/** @type {Record<string, string>} */",
        "export const PLATFORM_ACTION_ZH = {",
    ]
    for k in sorted(actions):
        lines.append(f"  {_js_str(k)}: {_js_str(actions[k])},")
    lines += [
        "}",
        "",
        "/** 常见 op 动词（未登记完整 action 时的回退）。 */",
        "/** @type {Record<string, string>} */",
        "export const PLATFORM_OP_ZH = {",
    ]
    for k, v in OP_FALLBACK.items():
        lines.append(f"  {k}: {_js_str(v)},")
    lines += [
        "}",
        "",
        "/**",
        " * @param {string | null | undefined} action",
        " * @returns {string}",
        " */",
        "export function platformActionLabelZh(action) {",
        "  const raw = String(action || '').trim()",
        "  if (!raw) return ''",
        "  const hit = PLATFORM_ACTION_ZH[raw]",
        "  if (hit) return hit",
        "  const lower = raw.toLowerCase()",
        "  if (lower !== raw) {",
        "    const hit2 = PLATFORM_ACTION_ZH[lower]",
        "    if (hit2) return hit2",
        "  }",
        "  const dot = raw.indexOf('.')",
        "  if (dot > 0) {",
        "    const domain = raw.slice(0, dot)",
        "    const op = raw.slice(dot + 1)",
        "    const domainZh = PLATFORM_DOMAIN_ZH[domain] || domain",
        "    const opZh = PLATFORM_OP_ZH[op.toLowerCase()]",
        "    if (opZh) return `${domainZh} · ${opZh}`",
        "    return `${domainZh} · ${op}`",
        "  }",
        "  return PLATFORM_DOMAIN_ZH[raw] || raw",
        "}",
        "",
        "/**",
        " * 折叠条 / 活动行用的短标签：优先完整 summary，过长则截到域 · op。",
        " * @param {string | null | undefined} action",
        " * @param {{ max?: number }} [opts]",
        " * @returns {string}",
        " */",
        "export function platformActionShortLabelZh(action, opts) {",
        "  const full = platformActionLabelZh(action)",
        "  if (!full) return ''",
        "  const max = opts?.max ?? 18",
        "  if (full.length <= max) return full",
        "  const raw = String(action || '').trim()",
        "  const dot = raw.indexOf('.')",
        "  if (dot > 0) {",
        "    const domain = raw.slice(0, dot)",
        "    const op = raw.slice(dot + 1)",
        "    const domainZh = PLATFORM_DOMAIN_ZH[domain] || domain",
        "    const opZh = PLATFORM_OP_ZH[op.toLowerCase()] || op",
        "    const short = `${domainZh} · ${opZh}`",
        "    return short.length <= max ? short : `${short.slice(0, max)}…`",
        "  }",
        "  return `${full.slice(0, max)}…`",
        "}",
        "",
        "/**",
        " * @param {string | null | undefined} domain",
        " * @returns {string}",
        " */",
        "export function platformDomainLabelZh(domain) {",
        "  const d = String(domain || '').trim()",
        "  if (!d) return ''",
        "  return PLATFORM_DOMAIN_ZH[d] || d",
        "}",
        "",
    ]
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT} ({len(actions)} actions, {len(domains)} domains)")


if __name__ == "__main__":
    main()
