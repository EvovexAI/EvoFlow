from evoflow.skills.skill_uri import (
    SKILL_URI_PREFIX,
    parse_skill_uri,
    resolve_skill_uri,
)


def test_parse_skill_uri_main() -> None:
    assert parse_skill_uri("skill:foo") == ("foo", "")
    assert parse_skill_uri("skill:Foo/Bar/baz.md") == ("foo", "Bar/baz.md")


def test_parse_skill_uri_invalid() -> None:
    assert parse_skill_uri("/abs/path") is None
    assert parse_skill_uri("skill:") is None
    assert parse_skill_uri("") is None
    assert parse_skill_uri("skill:abc/../../etc/passwd") is None
    assert parse_skill_uri("skill:abc/../secret.md") is None


def test_resolve_skill_uri_preset_role_assistant() -> None:
    p = resolve_skill_uri("skill:preset-role-assistant", require_enabled=False)
    assert p is not None
    assert p.name == "SKILL.md"
    assert "preset-role-assistant" in str(p).replace("\\", "/")


def test_skill_uri_prefix_constant() -> None:
    assert SKILL_URI_PREFIX == "skill:"
