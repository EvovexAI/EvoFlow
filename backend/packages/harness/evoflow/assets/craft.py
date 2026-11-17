"""Craft skills under Asset Hub ``craft/*.md`` (replaces experience library)."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from evoflow.assets.paths import EntityRef

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"[^a-z0-9_\u4e00-\u9fff-]+")

# 【fullstack-dev · 2026-11-15 · 第12轮】新建：标题同文判据要用到的归一化。
_H1_KEEP_RE = re.compile(r"[^0-9a-z\u4e00-\u9fff]+")
_H1_MARK_RE = re.compile(r"^#+\s*")
# 连接词与分隔符：title 与正文 H1 常常只差这些（slug 化会丢标点、并把连接处换成"与"）。
_H1_CONNECTOR_RE = re.compile(r"[-_·—…+/与和及或而、]+")


def _h1_norm(line: str) -> str:
    """把一行标题折成可比较的骨架：去 ``#``、去尾 ``.md``、只留汉字与字母数字。

    为什么：第11轮用字面相等判"重复标题"，但 hub 侧的 title 经过了 slug（``+``/``：`` 变 ``-``、
    标点丢失）和 ``title_from_body`` 的 60 字截断，正文 H1 是原话，两者只差标点或长度 → 判不出同文。
    实测最脏一例：title ``会话通知面板-状态中文化与压缩`` vs 正文 ``# 会话通知面板：状态中文化 + 压缩``
    —— slug 把 ``+`` 写成 ``-``，又把连接处补成 ``与``，第11轮的字面相等与前缀判断全都不命中。
    故这里连单字连接词一起吃掉：只用于"是不是同一句标题"的判断，不产出任何写入文本。
    边界：实词不同的仍不相等，不会被误删。
    """
    raw = str(line or "").strip()
    raw = _H1_MARK_RE.sub("", raw)
    if raw.lower().endswith(".md"):
        raw = raw[:-3]
    raw = _H1_CONNECTOR_RE.sub("", raw)
    return _H1_KEEP_RE.sub("", raw.lower())


def _title_text(data: dict[str, Any]) -> str:
    """取展示用标题：一律去掉模型粘来的 ``.md`` 后缀。

    【fullstack-dev · 2026-11-15 · 第12轮】新建。
    为什么：``strip_md_ext`` 此前只接在 ``_slug``（craft.py:19）上，文件名是干净了，
    **标题本身的渲染路径没接** —— 存量 ``craft/信息条类需求先确认面板归属.md`` 的第 13 行
    就是 ``# 信息条类需求先确认面板归属.md``，把人写的文件名当标题显示。同一条规则的读写两侧
    只修一侧，等于没修（这是本岗第 N 次撞"改一处漏一处"，见 standing）。
    """
    from evoflow.assets.ad_hoc_note import strip_md_ext

    return strip_md_ext(str(data.get("title") or "").strip())


def _note_body_title_from_path(data: dict[str, Any]) -> str:
    """note 路径兜底：从目标文件名（``skill_name``）取标题骨架。

    【fullstack-dev · 2026-11-15 · 第13轮增量二】新建。
    为什么：``assets note path=craft/x.md`` 时 hub.save_craft_note 传的 title 是**文件名 stem**，
    而正文首行是用户写的「## 小节名」——两者字面不同文，同文判据整段不命中，实测残留三层标题
    （``# 临时探针-h2去重验收`` → ``## 解决方案`` → ``## 与 title 同名的小节``）。
    文件名本身即该文件的标题口径（读侧 ``get_craft_experience`` 对无 H1 的正文就用 stem 当 title），
    所以正文首行归一化后若与 stem 同文/前缀，同样算重复标题。
    边界：仍要求归一化同文或 ≥12 字前缀；段落名（问题/解决方案/步骤…）与任何 stem 都不同文，不会被误删。
    """
    from evoflow.assets.ad_hoc_note import strip_md_ext

    return strip_md_ext(str(data.get("skill_name") or "").strip())


_TIME_LINE_RE = re.compile(r"^记录时间\s*[:：]")


def strip_duplicate_leading_heading(text: str, reference: str) -> str:
    """若 ``text`` 的首个标题行与 ``reference`` 里的标题同文，去掉那一行（只处理首行）。

    【fullstack-dev · 2026-11-15 · 第13轮增量二】新建：供 hub 追加路径复用同一判据。
    边界：归一化同文或 ≥12 字前缀才算重复；剥完为空则原样返回（宁可留重复也不吞内容）。
    """
    lines = str(text or "").splitlines()
    idx = 0
    while idx < len(lines) and (not lines[idx].strip() or _TIME_LINE_RE.match(lines[idx].strip())):
        idx += 1
    if idx >= len(lines) or not re.match(r"^#{1,6}\s", lines[idx]):
        return text
    _n = _h1_norm(lines[idx])
    if not _n:
        return text
    ref = str(reference or "").strip()
    wants: set[str] = set()
    if re.match(r"^#{1,6}\s", ref):
        wants.add(_h1_norm(ref.splitlines()[0]))
    else:
        wants.add(_h1_norm(_body_title(ref)))
        for ln in ref.splitlines():
            s = ln.strip()
            if re.match(r"^#{2,6}\s", s):
                wants.add(_h1_norm(s))
                break
        if ref and not any(wants):
            wants.add(_h1_norm(ref))  # reference 是纯文本标题（非 markdown）时直接比
    if any(w and (_n == w or _same_heading(_n, w)) for w in filter(None, wants)):
        lean = "\n".join(lines[:idx] + lines[idx + 1:]).strip()
        if lean:
            return lean
    return text


def ensure_no_double_heading(body: str) -> str:
    """正文自带 H1 时，若紧随其后的第一个非空标题行与 H1 同文 → 剥掉那一行（只剥一次）。"""
    lines = str(body or "").splitlines()
    if not lines or not lines[0].lstrip().startswith("# "):
        return body
    _w = _h1_norm(lines[0])
    k = 1
    while k < len(lines) and (not lines[k].strip() or _TIME_LINE_RE.match(lines[k].strip())):
        k += 1
    if k < len(lines) and re.match(r"^#{2,6}\s", lines[k]):
        _n = _h1_norm(lines[k])
        if _n and _w and (_n == _w or _same_heading(_n, _w)):
            lean = "\n".join(lines[:k] + lines[k + 1:]).strip()
            if lean:
                return lean
    return body


def _same_heading(a: str, b: str) -> bool:
    """两个归一化标题是否视为同一句：短侧是长侧前缀，且短侧 ≥12 字符（防短公共前缀误判）。"""
    if not a or not b:
        return False
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= 12 and long_.startswith(short)


def _slug(name: str, *, max_len: int = 48) -> str:
    from evoflow.assets.ad_hoc_note import strip_md_ext

    # Same trap as _slug_cjk: a pasted "runbook.md" title slugged to runbook-md.md.
    s = _SLUG_RE.sub("-", strip_md_ext(str(name or "")).strip().lower()).strip("-")
    if not s:
        s = "craft"
    return s[:max_len].strip("-") or "craft"


def _entity_from_data(data: dict[str, Any]) -> EntityRef:
    et = str(data.get("entity_type") or data.get("entity") or "user").strip().lower()
    eid = str(data.get("entity_id") or data.get("entityId") or "user").strip()
    if et == "user":
        # Respect a caller-supplied bucket id (per-principal ``users/<id>``);
        # legacy callers without an id keep the shared ``user`` bucket.
        from evoflow.assets.paths import sanitize_user_asset_id

        return EntityRef("user", sanitize_user_asset_id(eid or "user"))
    if et == "employee":
        return EntityRef("employee", eid.lower())
    return EntityRef("agent", eid.lower())


def _craft_root(entity: EntityRef) -> Path:
    from evoflow.assets.hub import ensure_entity_tree, entity_root

    ensure_entity_tree(entity)
    root = entity_root(entity) / "craft"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _parse_skill_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    raw = str(text or "")
    if not raw.startswith("---"):
        return {}, raw
    parts = raw.split("---", 2)
    if len(parts) < 3:
        return {}, raw
    meta: dict[str, Any] = {}
    for line in parts[1].strip().splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        key = k.strip()
        val = v.strip()
        if val.startswith("[") or val.startswith("{") or val.startswith('"'):
            try:
                meta[key] = json.loads(val)
            except json.JSONDecodeError:
                meta[key] = val
        else:
            meta[key] = val
    return meta, parts[2].lstrip()


def _build_skill_md(
    *,
    name: str,
    description: str,
    entity: EntityRef,
    body_md: str,
    meta: dict[str, Any],
) -> str:
    import yaml

    front: dict[str, Any] = {
        "name": name,
        "description": description[:500],
        "origin": str(meta.get("origin") or "distilled"),
        "entity": entity.entity_type,
        "entity_id": entity.entity_id,
    }
    for key in ("experience_id", "tags", "confidence", "category"):
        if meta.get(key) is not None:
            front[key] = meta.get(key)
    header = yaml.safe_dump(front, allow_unicode=True, sort_keys=False).strip()
    return f"---\n{header}\n---\n\n{body_md.strip()}\n"


def experience_to_skill_body(data: dict[str, Any]) -> str:
    # A caller-supplied ``body_md`` is already a full Markdown body — the unified
    # exit below renders it verbatim (deduping only against the real H1).
    ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
    problem = str(data.get("problem") or ctx.get("problem") or "").strip()
    solution = str(data.get("solution") or ctx.get("solution") or "").strip()
    # 【fullstack-dev · 2026-11-15 · 第11轮】改：正文首行若是与标题同文的 H1，去掉这一行重复标题。
    # 为什么：assets note(kind=experience) 走 hub.py:784 把**整篇正文**当 solution 传进来，而正文首行本身就是
    # ``# 标题``，于是套出「# 标题 … ## 解决方案 … # 标题 …」的双份标题（实测 craft/ 31 个文件里 5 个中招，
    # 其中就有我本轮刚写的 ci-local 配方）—— 白占注入篇幅，读起来像两份文档粘在一起。
    # 【fullstack-dev · 2026-11-15 · 第12轮】改：判据从「与 title 完全同文」换成**归一化同文 + 截断前缀**。
    # 为什么：第11轮那条只在字面完全相等时生效，实测 5 个中招文件里 **2 个根本不命中**——
    #   · ``会话通知面板-状态中文化与压缩`` vs 正文 ``# 会话通知面板：状态中文化 + 压缩``（标点/空格被 slug 化过）
    #   · title 是 ``title_from_body`` 截到 60 字的版本，正文 H1 更长（前缀相同、字面不等）
    # 即"同一句话被换了分隔符/截了尾"，第11轮的等值判断把它们放过了，等于没修好。
    # 边界：归一化只去掉空白与中英标点，**词不同的仍是两个标题**，不删（宁可留重复也不吞措辞）；
    #   前缀匹配要求短的一侧归一化后 ≥ 12 字，避免把「某某面板」这类短公共前缀误判成同文。
    # 不动 ``## 解决方案`` 这个段落名本身：craft.py:270/392 按它取列表/详情的 solution 字段，
    # 若改成传 body_md（verbatim 分支）虽去掉重复，却会让那两处的预览变空 —— 那是更坏的取舍。
    # 【fullstack-dev · 2026-11-15 · 第13轮】改：入口判据由 startswith("# ") 放宽到任意级标题行；
    # 且 _want 改走 _title_text（与 L184 渲染口径一致，顺带吃掉 .md 后缀差异）。
    # 为什么：note 的正文实际习惯是「## 小节名」起笔而非「# 标题」——第11/12轮的判据对这类正文
    #   **整段跳过**，本轮现网探针实测出三层重复：``# 探针第一段`` → ``## 解决方案`` → ``## 探针第一段（…）``。
    #   规则只修 H1 一面等于没修（本岗又撞"改一处漏一处"）。
    # 边界：判定仍要求**归一化同文或前缀**，``## 问题``/``## 解决方案`` 这类段落名与 title 不同文，不会被误删；
    #   删完正文若为空则不删，保住读侧 solution 预览字段（取舍同第11轮）。
    # 【fullstack-dev · 2026-11-15 · 第13轮增量二】改：本函数**不再**在此处剥重复标题，改为把
    #   note 传来的原始正文透传给 ``body_md``，由下面统一出口按**真正会渲染成 H1 的那一行**做去重。
    # 为什么：第11/12轮的判据拿 title/skill_name 比正文首行，但 assets note 路径 hub 传的 title 是
    #   **文件名 stem**、正文首行是用户写的「## 小节名」——字面永远不同文，放宽到 H2 也照样不命中
    #   （本轮离线复现三层重复仍在，证实只修判据文本没用，得把比对基准换成渲染出的那个 H1）。
    # 边界：结构化调用方（migrate / save_craft_from_experience 直调 problem/outcome/steps）仍走
    #   分节拼装，行为不变；只有"整篇正文当 solution"的 note 路径切到 verbatim 通道。
    outcome = str(data.get("outcome") or ctx.get("outcome") or "").strip()
    applicable = str(data.get("applicable_to") or ctx.get("applicable_to") or "").strip()
    steps = data.get("steps") or []
    if not isinstance(steps, list):
        steps = []
    # 【fullstack-dev · 2026-11-15 · 第14轮】改：verbatim 入口 = **仅**显式 ``body_md``，不再从 solution 猜。
    #   为什么：第13轮「solution 非空即 verbatim」把所有带 solution 的调用方卷进 verbatim——
    #   person_wrap_up / migrate / 测试契约里的结构化直调不再拼 ``## 问题``/``## 解决方案``，
    #   读侧 _sections_from_body 取空，列表/详情预览变空（驳回意见方向①：限定 verbatim 只对 note 路径生效）。
    #   我先前试过的 note_body=True 兜底是多余的：hub.save_craft_note 已显式传 body_md（见 hub.py），
    #   意图由调用方声明即可，不需要第二条标记通道。
    # 边界：无 body_md → 分节拼装，行为与 HEAD 一致（test_structured_caller_unchanged 绿）。
    raw_body = str(data.get("body_md") or "").strip()
    if raw_body:
        head_title = _title_text(data) or "专长"
        # 去重基准 = 真正渲染出的 H1（head_title），而非 data["title"] 的字面值。
        body_lines = raw_body.splitlines()
        # 【fullstack-dev · 2026-11-15 · 第14轮】改：verbatim 路径**先剥首行同文标题，再判是否自带 H1**。
        # 为什么：上一版把「首行是任意级标题」都当 verbatim 契约原样返回——正文以 ``# 标题``/
        #   ``## 与title同名小节`` 起笔的 note 会整篇直通，craft.py 顶层那个从未被调用的死函数
        #   （dedup_leading_heading）掩盖了这一点：判据写对了但**没接线**（本岗教训「自测要测接线」再现）。
        # 边界：剥完为空则不剥（heading-only 保内容）；不同文的标题不动。
        idx = 0
        while idx < len(body_lines) and (
            not body_lines[idx].strip() or _TIME_LINE_RE.match(body_lines[idx].strip())
        ):
            idx += 1
        if idx < len(body_lines) and re.match(r"^#{1,6}\s", body_lines[idx]):
            _n = _h1_norm(body_lines[idx])
            _w = _h1_norm(head_title)
            if _n and (_n == _w or _same_heading(_n, _w)):
                lean = "\n".join(body_lines[:idx] + body_lines[idx + 1:]).strip()
                if lean:
                    body_lines = lean.splitlines()
                    idx = 0
        # 若正文自带 H1，就尊重它（verbatim 契约），不再套一层；否则补渲染标题。
        if body_lines and body_lines[0].lstrip().startswith("# "):
            return ensure_no_double_heading("\n".join(body_lines)) + "\n"
        merged = "\n".join(body_lines).strip()
        # 【fullstack-dev · 2026-11-15 · 第14轮】改：verbatim 正文若被补了 H1（不自带标题行），
        #   在渲染出的 H1 之后补一行 ``## 解决方案``，让读侧 ``_sections_from_body``
        #   （craft.py 列表 L~434 / 详情 L~564 的 solution 预览字段）仍取得到内容。
        # 为什么：note 路径整篇正文走 verbatim 后不再套 ``## 解决方案`` 分节，
        #   而读侧只认这个段落名 —— 不补口径，列表/详情预览会变空（写侧改了读侧没跟上）。
        # 边界：正文自带 H1 → 上面分支原样返回，不动它；正文首个标题已是标准段落名
        #   （问题/结果/适用场景/步骤）→ 用户本来就在按段落写，不重复插标记；
        #   同名小节刚被去重剥掉的情况**要**补回来（第13轮 H2 探针用例要求去重后仍有 ``## 解决方案``）。
        if merged:
            first = body_lines[0].strip() if body_lines else ""
            already_sectioned = re.match(r"^##\s*(问题|结果|适用场景|步骤)\s*$", first)
            if not already_sectioned and "## 解决方案" not in merged:
                merged = f"## 解决方案\n\n{merged}"
        return f"# {head_title}\n\n{merged}\n" if merged else f"# {head_title}\n"

    parts: list[str] = [f"# {_title_text(data) or '专长'}\n"]
    if applicable:
        parts.append(f"\n## 适用场景\n{applicable}\n")
    if problem:
        parts.append(f"\n## 问题\n{problem}\n")
    if solution:
        parts.append(f"\n## 解决方案\n{solution}\n")
    if outcome:
        parts.append(f"\n## 结果\n{outcome}\n")
    if steps:
        parts.append("\n## 步骤\n")
        for i, step in enumerate(steps, 1):
            parts.append(f"{i}. {str(step).strip()}\n")
    return "\n".join(parts).strip() + "\n"


def save_craft_from_experience(data: dict[str, Any]) -> dict[str, Any]:
    # 【fullstack-dev · 2026-11-15 · 第12轮】改：入口标题先去 .md 后缀，frontmatter 的 name/description
    # 与正文 H1 才会一致（此前只有文件名干净，标题带着 .md 显示）。
    title = _title_text(data)
    if not title:
        raise ValueError("title is required")
    entity = _entity_from_data(data)
    exp_id = str(data.get("id") or data.get("experience_id") or "").strip()
    if not exp_id:
        import uuid

        exp_id = f"exp_{uuid.uuid4().hex[:12]}"
    # 【self-evolution-bot · 2026-11-17 · 第31轮】改：调用方显式给了 skill_name 时按其**全长**净化，
    #   不再一律折回 max_len=48。为什么：hub.save_craft_note 撞名护栏传进来的 stem 是
    #   「48 字截断 base + 随机后缀」（53 字），旧写法 _slug 把后缀再截掉 → 写回撞名 base 文件并
    #   整篇重建，**另一篇配方被静默吞掉**（回归测试 test_slug_collision_but_different_title 钉住：
    #   B 落盘后 A 的正文只剩 B）。不带 skill_name 的旧调用（migrate 等）行为不变。
    _requested_skill = str(data.get("skill_name") or "").strip()
    slug = (
        _slug(_requested_skill, max_len=max(48, len(_requested_skill)))
        if _requested_skill
        else _slug(title)
    )
    craft_root = _craft_root(entity)
    skill_path = craft_root / f"{slug}.md"
    tags = data.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    from evoflow.assets.ad_hoc_note import ensure_body_recorded_at

    body = ensure_body_recorded_at(experience_to_skill_body(data)).strip()
    description = str(data.get("description") or problem_summary(data) or title)[:500]
    meta = {
        "origin": str(data.get("origin") or "migrated_experience"),
        "experience_id": exp_id,
        "tags": tags,
        "confidence": float(data.get("confidence") or 1.0),
        "category": str(data.get("category") or "general"),
    }
    content = _build_skill_md(
        name=slug,
        description=description,
        entity=entity,
        body_md=body,
        meta=meta,
    )
    tmp = skill_path.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(skill_path)
    rel = skill_path.relative_to(craft_root.parent).as_posix()
    try:
        from evoflow.assets.memory_mirror import schedule_asset_vault_reindex_delayed

        schedule_asset_vault_reindex_delayed()
    except Exception:
        logger.debug("craft reindex schedule skipped", exc_info=True)
    return {
        "success": True,
        "id": exp_id,
        "title": title,
        "skill_name": slug,
        "path": rel,
        "entityType": entity.entity_type,
        "entityId": entity.entity_id,
        "storage": "craft",
    }


def problem_summary(data: dict[str, Any]) -> str:
    """One-line description for the SKILL.md frontmatter.

    Prefers an explicit ``description``; otherwise derives a concise first line
    from problem/solution/title. Keeping this short matters because the front
    matter ``description`` is what list views surface.
    """
    explicit = str(data.get("description") or "").strip()
    if explicit:
        return explicit[:200]
    ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
    raw = str(data.get("problem") or ctx.get("problem") or data.get("solution") or ctx.get("solution") or "")
    if not raw.strip():
        # A verbatim body: use its first real line, skipping the H1/## headings.
        raw = str(data.get("body_md") or "")
        for line in raw.splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                return s[:160]
    first_line = next((ln.strip() for ln in raw.splitlines() if ln.strip()), "")
    return (first_line or str(data.get("title") or ""))[:160]


def list_craft_experiences(
    *,
    category: str = "",
    query: str = "",
    max_results: int = 50,
    entity: EntityRef | None = None,
) -> dict[str, Any]:
    from evoflow.assets.hub import assets_root

    root = assets_root()
    patterns = []
    if entity is not None:
        from evoflow.assets.paths import entity_root

        patterns.append(entity_root(entity) / "craft")
    else:
        patterns.extend(
            [
                root / "user" / "craft",
                root / "agents",
                root / "employees",
            ]
        )
    hits: list[dict[str, Any]] = []
    q = str(query or "").strip().lower()
    cat_prefix = str(category or "").strip().lower()

    def _scan_craft_dir(craft_dir: Path, entity_type: str, entity_id: str) -> None:
        if not craft_dir.is_dir():
            return
        for skill_md in sorted(craft_dir.glob("*.md")):
            if skill_md.name.upper() == "README.MD":
                continue
            try:
                text = skill_md.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = _parse_skill_frontmatter(text)
            title = str(meta.get("name") or skill_md.stem).replace("-", " ")
            exp_id = str(meta.get("experience_id") or meta.get("id") or skill_md.stem)
            cat = str(meta.get("category") or "general")
            if cat_prefix and not cat.lower().startswith(cat_prefix):
                continue
            blob = f"{title}\n{body}\n{meta.get('description', '')}".lower()
            if q and q not in blob:
                continue
            sections = _sections_from_body(body)
            # The H1 in the body is the real title; ``description`` is a summary.
            display_title = _body_title(body) or str(meta.get("description") or title)
            hits.append(
                {
                    "id": exp_id,
                    "title": display_title[:120],
                    "category": cat,
                    "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
                    "problem": sections["problem"][:200],
                    "solution": sections["solution"][:200],
                    "outcome": sections["outcome"][:100],
                    "step_count": len(sections["steps"]),
                    "confidence": float(meta.get("confidence") or 1.0),
                    "use_count": 0,
                    "storage": "craft",
                    "path": (skill_md.relative_to(root).as_posix() if root in skill_md.resolve().parents or skill_md.resolve() == root.resolve() else skill_md.as_posix()),
                    "entityType": str(meta.get("entity") or entity_type),
                    "entityId": str(meta.get("entity_id") or entity_id),
                }
            )

    if entity is not None:
        from evoflow.assets.paths import entity_root as _entity_root

        craft_base = _entity_root(entity)
        _scan_craft_dir(craft_base / "craft", entity.entity_type, entity.entity_id)
    else:
        _scan_craft_dir(root / "user" / "craft", "user", "user")
        # Multi-user installs: per-principal buckets ``assets/users/<id>/craft``.
        # Asset Center shows the caller's personal bucket, so experiences saved
        # with a principal_id must be discoverable from the shared listing too.
        users_root = root / "users"
        if users_root.is_dir():
            for user_dir in sorted(users_root.iterdir()):
                if user_dir.is_dir() and not user_dir.name.startswith("."):
                    _scan_craft_dir(user_dir / "craft", "user", user_dir.name)
        agents_root = root / "agents"
        if agents_root.is_dir():
            for agent_dir in agents_root.iterdir():
                if agent_dir.is_dir():
                    _scan_craft_dir(agent_dir / "craft", "agent", agent_dir.name)
        emp_root = root / "employees"
        if emp_root.is_dir():
            for emp_dir in emp_root.iterdir():
                if emp_dir.is_dir():
                    _scan_craft_dir(emp_dir / "craft", "employee", emp_dir.name)

    hits.sort(key=lambda h: (h.get("confidence", 0), h.get("title", "")), reverse=True)
    # Respect caller max_results; soft cap 500 to avoid unbounded scans (DEF-02).
    # Always expose full matched ``total`` so callers are not fooled by page size (CORE-ASSET-03).
    limit = max(1, min(int(max_results or 50), 500))
    total = len(hits)
    page = hits[:limit]
    return {
        "items": page,
        "count": len(page),
        "total": total,
        "limit": limit,
        "has_more": total > limit,
        "query": q or None,
        "category": cat_prefix or None,
    }


def _iter_craft_skill_files() -> list[tuple[Path, str, str]]:
    """Yield ``(skill_md, entity_type, entity_id)`` under Asset Hub craft trees."""
    from evoflow.assets.hub import assets_root

    root = assets_root()
    out: list[tuple[Path, str, str]] = []

    def _collect(craft_dir: Path, entity_type: str, entity_id: str) -> None:
        if not craft_dir.is_dir():
            return
        for skill_md in craft_dir.glob("*.md"):
            if skill_md.name.upper() == "README.MD":
                continue
            out.append((skill_md, entity_type, entity_id))

    _collect(root / "user" / "craft", "user", "user")
    users_root = root / "users"
    if users_root.is_dir():
        for user_dir in users_root.iterdir():
            if user_dir.is_dir() and not user_dir.name.startswith("."):
                _collect(user_dir / "craft", "user", user_dir.name)
    agents_root = root / "agents"
    if agents_root.is_dir():
        for agent_dir in agents_root.iterdir():
            if agent_dir.is_dir():
                _collect(agent_dir / "craft", "agent", agent_dir.name)
    emp_root = root / "employees"
    if emp_root.is_dir():
        for emp_dir in emp_root.iterdir():
            if emp_dir.is_dir():
                _collect(emp_dir / "craft", "employee", emp_dir.name)
    return out


def get_craft_experience(experience_id: str) -> dict[str, Any] | None:
    """Load one craft entry by id — direct file scan, not truncated list (DEF-02)."""
    eid = str(experience_id or "").strip()
    if not eid:
        return None
    from evoflow.assets.hub import assets_root, entity_root, read_text_file
    from evoflow.assets.paths import EntityRef

    root = assets_root()
    for skill_md, entity_type, entity_id in _iter_craft_skill_files():
        try:
            text = skill_md.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, body = _parse_skill_frontmatter(text)
        exp_id = str(meta.get("experience_id") or meta.get("id") or skill_md.stem)
        if exp_id != eid and skill_md.stem != eid:
            continue
        ent = EntityRef(entity_type, entity_id)
        try:
            rel_from_root = skill_md.resolve().relative_to(root.resolve()).as_posix()
        except Exception:
            rel_from_root = skill_md.as_posix()
        try:
            entity_rel = skill_md.resolve().relative_to(entity_root(ent).resolve()).as_posix()
        except Exception:
            entity_rel = f"craft/{skill_md.name}"
        try:
            file_data = read_text_file(ent, entity_rel)
            body_src = file_data.get("content") or text
        except Exception:
            body_src = text
        meta, body = _parse_skill_frontmatter(body_src)
        sections = _sections_from_body(body)
        return {
            "id": eid,
            "title": _body_title(body) or str(meta.get("description") or skill_md.stem),
            "category": str(meta.get("category") or "general"),
            "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
            "context": {
                "problem": sections["problem"],
                "solution": sections["solution"],
                "outcome": sections["outcome"],
                "applicable_to": sections["applicable_to"],
            },
            "steps": sections["steps"],
            "source_sessions": [],
            "related_ids": [],
            "confidence": float(meta.get("confidence") or 1.0),
            "use_count": 0,
            "superseded_by": None,
            "deprecated": False,
            "storage": "craft",
            "path": rel_from_root,
            "entityType": entity_type,
            "entityId": entity_id,
        }
    return None


def delete_craft_experience(experience_id: str) -> bool:
    row = get_craft_experience(experience_id)
    if not row:
        return False
    from evoflow.assets.hub import assets_root

    path = assets_root() / str(row.get("path") or "")
    if path.is_file():
        path.unlink()
        try:
            from evoflow.assets.memory_mirror import schedule_asset_vault_reindex_delayed

            schedule_asset_vault_reindex_delayed()
        except Exception:
            pass
        return True
    return False


def _section_text(body: str, heading: str) -> str:
    marker = f"## {heading}"
    if marker not in body:
        return ""
    part = body.split(marker, 1)[1]
    if "##" in part:
        part = part.split("##", 1)[0]
    return part.strip()


def _body_title(body: str) -> str:
    """First ``# heading`` of a SKILL.md body — the human title."""
    for line in str(body or "").splitlines():
        s = line.strip()
        if s.startswith("# "):
            return s[2:].strip()
    return ""


def _sections_from_body(body: str) -> dict[str, Any]:
    """Extract the standard experience sections from a craft SKILL.md body.

    Single source of truth for both the list summary and the detail view, so
    the two can never disagree about what a stored experience contains.
    """
    steps: list[str] = []
    if "## 步骤" in body:
        section = body.split("## 步骤", 1)[1]
        for line in section.splitlines():
            m = re.match(r"^\s*\d+\.\s+(.*)", line.strip())
            if m:
                steps.append(m.group(1).strip())
    return {
        "applicable_to": _section_text(body, "适用场景"),
        "problem": _section_text(body, "问题"),
        "solution": _section_text(body, "解决方案"),
        "outcome": _section_text(body, "结果"),
        "steps": steps,
    }
