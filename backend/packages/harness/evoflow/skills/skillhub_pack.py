"""Install SkillHub expert packages (skillsets) as custom agents + skills.

Public API used by Gateway and the debug CLI:

- ``parse_skillset_slug``
- ``fetch_skillset``
- ``install_skillhub_expert_pack``
"""

from __future__ import annotations

import io
import json
import logging
import re
import shutil
import tempfile
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

SKILLHUB_API = "https://api.skillhub.cn"
AVATAR_CDN = (
    "https://cloudcache.tencent-cloud.com/qcloud/tea/app/skillhub/assets/source/ai-buddy-decouple"
)
AVATAR_VERSION = "v20260625"
AVATAR_EXT = "avif"
_AVATAR_VERSION_OVERRIDES = frozenset(
    {
        "tech-tencentcloud-expert",
        "mysticism-ziwei-doushu",
        "mysticism-yijing-divination",
        "mysticism-lunar-almanac",
        "lifestyle-nutrition-meal-plan",
        "lifestyle-mental-counseling",
        "lifestyle-meditation-mindfulness",
        "lifestyle-health-data-analysis",
        "lifestyle-fitness-training",
        "ecommerce-user-profiling",
        "ecommerce-review-analysis",
        "content-creation-poetry-creation",
        "mysticism-tarot-divination",
        "mysticism-bazi-analysis",
        "content-creation-screenwriting",
        "mysticism-zodiac-fortune",
        "content-creation-story-outlining",
        "content-creation-novel-writing",
        "content-creation-lyrics-songwriting",
        "ecommerce-promotion-planning",
        "ecommerce-pricing-analysis",
        "marketing-competitor-analysis",
    }
)

_SCENE_TAGS: dict[str, list[str]] = {
    "media": ["媒体", "内容"],
    "marketing": ["营销"],
    "content-creation": ["内容"],
    "tech": ["技术"],
    "ecommerce": ["电商"],
    "design": ["设计"],
    "education": ["教育"],
    "finance": ["金融"],
    "healthcare": ["健康"],
    "hr": ["人力"],
    "legal": ["法务"],
    "lifestyle": ["生活"],
    "academic": ["学术"],
}

# Workspace baseline for SkillHub experts: read/search/write deliverables + light web research.
# Do not include subagent/plan/supervisor (experts execute; they do not orchestrate).
EXPERT_BASELINE_TOOLS: tuple[str, ...] = (
    "read",
    "rg",
    "find",
    "write",
    "replace",
    "delete",
    "terminal",
    "todo",
    "web_search",
    "fetch_url",
)

# Belt-and-suspenders: even if mode catalogs list these, experts must not orchestrate.
EXPERT_DISALLOWED_TOOLS: tuple[str, ...] = (
    "subagent",
    "task",
    "plan",
    "supervisor",
    "propose_goal",
    "collab_peer_send",
    "collab_peer_read",
    "collab_peer_reply",
    "subtask_outcome_report",
    "subtask_progress_report",
    "subtask_work_checklist",
    "list_agents",
    "invoke_acp_agent",
)

_AGENT_CODE_RE = re.compile(r"^[a-z0-9-]+$")


@dataclass
class SkillInstallResult:
    slug: str
    status: str  # installed | exists | failed
    skill_name: str | None = None
    message: str = ""


@dataclass
class ExpertPackInstallResult:
    agent_code: str
    agent_name: str
    slug: str
    skills: list[str] = field(default_factory=list)
    skill_results: list[SkillInstallResult] = field(default_factory=list)
    avatar_path: str | None = None
    created: bool = True

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d


def _http_get(url: str, *, timeout: float = 60.0) -> tuple[str, bytes]:
    req = Request(url, headers={"User-Agent": "EvoFlow-SkillHubPack/1.0", "Accept": "*/*"})
    with urlopen(req, timeout=timeout) as resp:
        ct = resp.headers.get("Content-Type", "") or ""
        return ct, resp.read()


def parse_skillset_slug(url_or_slug: str) -> str:
    raw = (url_or_slug or "").strip()
    if not raw:
        raise ValueError("empty url/slug")
    if "://" not in raw and "/" not in raw:
        slug = raw.lower()
    else:
        path = urlparse(raw).path.strip("/")
        parts = [p for p in path.split("/") if p]
        if "skillspackage" in parts:
            i = parts.index("skillspackage")
            if i + 1 >= len(parts):
                raise ValueError(f"cannot parse skillset slug from: {url_or_slug!r}")
            slug = parts[i + 1].lower()
        else:
            slug = parts[-1].lower() if parts else ""
    if not slug or not _AGENT_CODE_RE.match(slug):
        raise ValueError(f"invalid skillset slug: {slug!r}")
    return slug


def fetch_skillset(slug: str) -> dict[str, Any]:
    url = f"{SKILLHUB_API}/api/v1/skillsets/{quote(slug, safe='')}"
    ct, raw = _http_get(url, timeout=30)
    if "json" not in ct and raw[:1] not in (b"{", b"["):
        raise RuntimeError(f"unexpected content-type for skillset detail: {ct}")
    data = json.loads(raw.decode("utf-8"))
    if isinstance(data, dict) and isinstance(data.get("data"), dict) and not data.get("slug"):
        data = data["data"]
    if not isinstance(data, dict) or not data.get("slug"):
        raise RuntimeError(f"invalid skillset payload for {slug!r}")
    return data


def expert_avatar_url(slug: str) -> str:
    ver = "v20260702" if slug in _AVATAR_VERSION_OVERRIDES else AVATAR_VERSION
    return f"{AVATAR_CDN}/expert-profiles/{quote(slug, safe='')}.{ver}.{AVATAR_EXT}"


def _split_package_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    text = (content or "").strip()
    if not text.startswith("---"):
        return {}, text
    m = re.match(r"^---\s*\n([\s\S]*?)\n---\s*\n?", text)
    if not m:
        return {}, text
    body = text[m.end() :].lstrip("\n")
    meta: dict[str, Any] = {}
    fm = m.group(1)
    name_m = re.search(r"^name:\s*(.+)$", fm, re.M)
    if name_m:
        meta["name"] = name_m.group(1).strip().strip("\"'")
    desc_m = re.search(r"^description:\s*>-?\s*\n((?:[ \t]+.+\n)+)", fm, re.M)
    if desc_m:
        lines = [ln.strip() for ln in desc_m.group(1).splitlines() if ln.strip()]
        meta["description"] = " ".join(lines)
    else:
        one = re.search(r"^description:\s*(.+)$", fm, re.M)
        if one:
            meta["description"] = one.group(1).strip()
    kids = re.findall(r"^\s+-\s+(\S+)\s*$", fm, re.M)
    if kids:
        meta["children"] = kids
    return meta, body


def _slugify_skill_name(raw: str, fallback: str) -> str:
    s = (raw or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    s = re.sub(r"-{2,}", "-", s)
    if s and re.match(r"^[a-z0-9-]+$", s) and len(s) <= 64:
        return s
    fb = re.sub(r"[^a-z0-9]+", "-", (fallback or "skill").strip().lower()).strip("-")
    return (fb[:64] or "skill")


def normalize_skill_md_frontmatter(text: str, *, slug: str) -> str:
    """Rewrite SkillHub SKILL.md into installable hyphen-case frontmatter."""
    import yaml

    from evoflow.skills.frontmatter import split_skill_frontmatter

    split = split_skill_frontmatter(text)
    if split is None:
        name = _slugify_skill_name(slug, slug)
        desc = f"SkillHub skill {slug}"
        return f'---\nname: {name}\ndescription: "{desc}"\n---\n\n{text.lstrip()}'

    fm_text, body = split
    name: str | None = None
    desc: str | None = None
    try:
        parsed = yaml.safe_load(fm_text)
        if isinstance(parsed, dict):
            if isinstance(parsed.get("name"), str):
                name = parsed["name"].strip()
            d = parsed.get("description")
            if isinstance(d, str) and d.strip():
                desc = d.strip()
            elif isinstance(d, list):
                desc = " ".join(str(x).strip() for x in d if str(x).strip())
    except Exception:
        pass

    if not name:
        m = re.search(r"^name:\s*(.+)\s*$", fm_text, re.M)
        if m:
            name = m.group(1).strip().strip("\"'")
    if not desc:
        m = re.search(r"^description:\s*(?:[|>][+-]?)?\s*(.*)$", fm_text, re.M)
        if m:
            first = m.group(1).strip().strip("\"'")
            lines = [first] if first else []
            after = fm_text[m.end() :]
            for line in after.splitlines():
                if not line.strip():
                    continue
                if re.match(r"^[A-Za-z0-9_-]+:\s*", line):
                    break
                if line.startswith((" ", "\t")):
                    lines.append(line.strip().strip("\"'"))
                else:
                    if ":" not in line.split(" ", 1)[0]:
                        lines.append(line.strip().strip("\"'"))
                    else:
                        break
            desc = " ".join(x for x in lines if x)

    name = _slugify_skill_name(name or slug, slug)
    if not desc:
        desc = f"SkillHub skill {slug}"
    if len(desc) > 1000:
        desc = desc[:997] + "..."
    desc_q = '"' + desc.replace("\\", "\\\\").replace('"', '\\"') + '"'
    new_fm = f"name: {name}\ndescription: {desc_q}\n"
    if body.startswith("\n"):
        return f"---\n{new_fm}---\n{body}"
    return f"---\n{new_fm}---\n\n{body}"


def _avatar_to_webp(data: bytes) -> bytes:
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP":
        return data
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return data
    from PIL import Image

    im = Image.open(io.BytesIO(data))
    if im.mode in ("P", "LA"):
        im = im.convert("RGBA")
    elif im.mode != "RGBA":
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, format="WEBP", quality=90)
    return buf.getvalue()


def _download_and_normalize_skill_zip(slug: str) -> Path:
    url = f"{SKILLHUB_API}/api/v1/download?slug={quote(slug, safe='')}"
    _, raw = _http_get(url, timeout=90)
    if len(raw) < 64 or raw[:2] != b"PK":
        raise RuntimeError(f"skill download not a zip (slug={slug}, len={len(raw)})")

    work = Path(tempfile.mkdtemp(prefix="skillhub-pack-"))
    src_zip = work / f"{slug}.src.zip"
    src_zip.write_bytes(raw)
    extract = work / "extract"
    extract.mkdir()
    with zipfile.ZipFile(src_zip, "r") as zf:
        zf.extractall(extract)

    skill_md = next(extract.rglob("SKILL.md"), None)
    if skill_md is None:
        shutil.rmtree(work, ignore_errors=True)
        raise RuntimeError(f"no SKILL.md in zip for {slug}")

    original = skill_md.read_text(encoding="utf-8", errors="replace")
    skill_md.write_text(normalize_skill_md_frontmatter(original, slug=slug), encoding="utf-8")

    root_items = [p for p in extract.iterdir() if p.name not in {".DS_Store", "__MACOSX"}]
    if len(root_items) == 1 and root_items[0].is_dir():
        wrapper_src = root_items[0]
        wrapper_name = wrapper_src.name
    else:
        wrapper_name = slug
        wrapper_src = extract

    out_zip = work / f"{slug}.zip"
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        base = wrapper_src
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            if "__MACOSX" in p.parts or p.name.startswith("."):
                continue
            arc = f"{wrapper_name}/{p.relative_to(base).as_posix()}"
            zf.write(p, arcname=arc)
    return out_zip


def _install_one_skill(slug: str, *, force: bool = False) -> SkillInstallResult:
    from evoflow.skills.installer import SkillAlreadyExistsError, install_skill_from_archive
    from evoflow.skills.loader import get_skills_root_path

    zip_path = _download_and_normalize_skill_zip(slug)
    work = zip_path.parent
    try:
        try:
            result = install_skill_from_archive(zip_path)
            return SkillInstallResult(
                slug=slug,
                status="installed",
                skill_name=str(result.get("skill_name") or slug),
                message=str(result.get("message") or ""),
            )
        except SkillAlreadyExistsError as e:
            name = None
            m = re.search(r"'([^']+)'", str(e))
            if m:
                name = m.group(1)
            if force and name:
                target = get_skills_root_path() / "custom" / name
                if target.is_dir():
                    shutil.rmtree(target)
                result = install_skill_from_archive(zip_path)
                return SkillInstallResult(
                    slug=slug,
                    status="installed",
                    skill_name=str(result.get("skill_name") or name),
                    message=f"reinstalled: {result.get('message') or ''}",
                )
            return SkillInstallResult(
                slug=slug,
                status="exists",
                skill_name=name or slug,
                message=str(e),
            )
    except Exception as e:
        logger.warning("skill install failed slug=%s: %s", slug, e, exc_info=True)
        return SkillInstallResult(slug=slug, status="failed", skill_name=None, message=str(e))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _enable_skills(names: list[str]) -> None:
    try:
        from evoflow.config.extensions_config import SkillStateConfig, get_extensions_config, set_extensions_config
        from evoflow.persistence import config_repositories as cfg_repo
    except Exception:
        logger.debug("enable_skills: extensions unavailable", exc_info=True)
        return
    try:
        extensions_config = get_extensions_config()
        for name in names:
            cfg_repo.set_skill_enabled(name, True)
            extensions_config.skills[name] = SkillStateConfig(enabled=True)
        set_extensions_config(extensions_config)
    except Exception:
        logger.debug("enable_skills failed", exc_info=True)


def _resolve_skill_names(slugs: list[str], results: list[SkillInstallResult]) -> list[str]:
    from evoflow.skills import load_skills
    from evoflow.skills.loader import clear_skills_cache

    clear_skills_cache()
    by_name = {s.name: s for s in load_skills(enabled_only=False)}
    names: list[str] = []
    for slug, res in zip(slugs, results, strict=False):
        candidate = res.skill_name or slug
        if candidate in by_name:
            names.append(candidate)
            continue
        matched = None
        for s in by_name.values():
            loc = str(getattr(s, "location", "") or getattr(s, "path", "") or "")
            if slug in loc.replace("\\", "/").split("/"):
                matched = s.name
                break
        names.append(matched or candidate)
    out: list[str] = []
    seen: set[str] = set()
    for n in names:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _save_avatar(agent_code: str, slug: str) -> str | None:
    from evoflow.config.agent_avatars import save_avatar_bytes

    url = expert_avatar_url(slug)
    try:
        _, raw = _http_get(url, timeout=30)
    except Exception as e:
        logger.warning("avatar download failed slug=%s: %s", slug, e)
        return None
    if len(raw) < 64:
        return None
    try:
        webp = _avatar_to_webp(raw)
        path = save_avatar_bytes(agent_code, webp)
        return str(path)
    except Exception as e:
        logger.warning("avatar save failed agent=%s: %s", agent_code, e)
        return None


def install_skillhub_expert_pack(
    url_or_slug: str,
    *,
    agent_code: str | None = None,
    force_skills: bool = False,
) -> ExpertPackInstallResult:
    """Fetch a SkillHub skillset and materialize it as a custom agent + skills."""
    from evoflow.config.agents_config import load_agent_config, save_agent_config, save_agent_soul
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.skills.loader import clear_skills_cache

    slug = parse_skillset_slug(url_or_slug)
    data = fetch_skillset(slug)
    display = str(data.get("displayName") or slug).strip()
    summary = str(data.get("summary") or "").strip()
    skill_slugs = [str(s).strip() for s in (data.get("skillSlugs") or []) if str(s).strip()]
    scene = str(data.get("scene") or "").strip()
    content = str(data.get("content") or "")
    meta, body = _split_package_frontmatter(content)
    if not skill_slugs:
        skill_slugs = [str(s).strip() for s in (meta.get("children") or []) if str(s).strip()]
    if not skill_slugs:
        raise ValueError(f"skillset {slug!r} has no skillSlugs")

    description = summary or str(meta.get("description") or display)
    soul = body.strip() or f"# {display}\n\n{description}\n"
    code = (agent_code or slug).strip().lower()
    if not _AGENT_CODE_RE.match(code):
        raise ValueError(f"invalid agent_code: {code!r}")

    tags = list(_SCENE_TAGS.get(scene, []))
    if "SkillHub" not in tags:
        tags.append("SkillHub")

    skill_results = [_install_one_skill(s, force=force_skills) for s in skill_slugs]
    failed = [r for r in skill_results if r.status == "failed"]
    if len(failed) == len(skill_results):
        raise RuntimeError(
            "all skill installs failed: " + "; ".join(f"{r.slug}: {r.message}" for r in failed[:3])
        )

    clear_skills_cache()
    skill_names = _resolve_skill_names(skill_slugs, skill_results)
    _enable_skills(skill_names)

    created = not cfg_repo.agent_exists(code)
    payload = {
        "agent_code": code,
        "agent_type": "custom",
        "agent_name": display,
        "description": description,
        "skills": skill_names,
        "tags": tags,
        "avatar": "image",
        "tools": list(EXPERT_BASELINE_TOOLS),
        "disallowed_tools": list(EXPERT_DISALLOWED_TOOLS),
    }
    save_agent_config(code, payload)
    save_agent_soul(code, soul)
    avatar_path = _save_avatar(code, slug)

    # Re-read to confirm
    cfg = load_agent_config(code)
    return ExpertPackInstallResult(
        agent_code=code,
        agent_name=str(cfg.agent_name or display),
        slug=slug,
        skills=list(cfg.skills or skill_names),
        skill_results=skill_results,
        avatar_path=avatar_path,
        created=created,
    )
