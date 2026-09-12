"""Inline self-test for the capability registry (not a pytest module).

Run: python -m evoflow.capability._selftest
"""

from evoflow.capability import (
    CallerCtx,
    CapabilityMeta,
    CapabilityRegistry,
    DangerTier,
    Decision,
    Surface,
    capability,
    decide,
    default_decision,
    get_registry,
)
from pydantic import BaseModel as BM, Field


def test_matrix() -> None:
    exp = {
        (Surface.Desktop, DangerTier.Read): Decision.Allow,
        (Surface.Desktop, DangerTier.Write): Decision.Allow,
        (Surface.Desktop, DangerTier.Destructive): Decision.Confirm,
        (Surface.Desktop, DangerTier.Sensitive): Decision.Confirm,
        (Surface.Channel, DangerTier.Read): Decision.Allow,
        (Surface.Channel, DangerTier.Write): Decision.Allow,
        (Surface.Channel, DangerTier.Destructive): Decision.Deny,
        (Surface.Channel, DangerTier.Sensitive): Decision.Deny,
        (Surface.Remote, DangerTier.Read): Decision.Allow,
        (Surface.Remote, DangerTier.Write): Decision.Allow,
        (Surface.Remote, DangerTier.Destructive): Decision.Confirm,
        (Surface.Remote, DangerTier.Sensitive): Decision.Deny,
    }
    for (s, d), v in exp.items():
        assert default_decision(s, d) == v, (s, d, default_decision(s, d), v)
    print("2) default_decision matrix: OK")


def test_decide_overrides() -> None:
    md = CapabilityMeta("t_del", "test", "delete", DangerTier.Destructive)
    assert decide(md, Surface.Desktop, False) == Decision.Confirm
    assert decide(md, Surface.Desktop, True) == Decision.Allow
    assert decide(md, Surface.Channel, True) == Decision.Deny
    mw = CapabilityMeta("t_w", "test", "write", DangerTier.Write, deny_on=[Surface.Channel])
    assert decide(mw, Surface.Channel, True) == Decision.Deny
    assert decide(mw, Surface.Desktop, False) == Decision.Allow
    print("3) decide() overrides: OK")


def test_surface() -> None:
    assert CallerCtx(remote=True).surface() == Surface.Remote
    assert CallerCtx(remote=True, channel_platform="lark").surface() == Surface.Remote
    assert CallerCtx(channel_platform="lark").surface() == Surface.Channel
    assert CallerCtx().surface() == Surface.Desktop
    print("4) CallerCtx.surface: OK")


def test_decorator_and_dispatch() -> None:
    class EchoArgs(BM):
        text: str = Field(description="text to echo")

    reg = CapabilityRegistry()

    @capability(name="echo", domain="test", danger=DangerTier.Read, summary="echo back", registry=reg)
    def echo(ctx: CallerCtx, args: EchoArgs) -> dict:
        return {"echoed": args.text}

    specs = reg.tool_specs(Surface.Desktop)
    assert len(specs) == 1 and specs[0].name == "echo"
    assert "text" in specs[0].input_schema["properties"]
    assert "CallerCtx" not in specs[0].input_schema.get("properties", {})
    print("5a) tool_specs + schema gen: OK; props:", list(specs[0].input_schema["properties"].keys()))

    ctx = CallerCtx(user_id="u1")
    r = reg.dispatch("echo", {"text": "hi"}, ctx)
    assert r == {"echoed": "hi"}, r
    print("5b) dispatch Allow: OK ->", r)

    class DelArgs(BM):
        path: str

    @capability(name="rm", domain="test", danger=DangerTier.Destructive, summary="delete file", registry=reg)
    def rm(ctx: CallerCtx, args: DelArgs) -> dict:
        return {"deleted": args.path}

    assert reg.dispatch("rm", {"path": "/x"}, CallerCtx()) == {"needs_confirmation": True}
    assert reg.dispatch("rm", {"path": "/x", "confirm": True}, CallerCtx(channel_platform="lark")) == {"error": "denied"}
    assert reg.dispatch("rm", {"path": "/x", "confirm": True}, CallerCtx()) == {"deleted": "/x"}
    print("6) dispatch Confirm/Deny/Allow flow: OK")

    assert get_registry() is get_registry()
    print("7) get_registry singleton: OK")

    dspec = [s for s in reg.tool_specs(Surface.Desktop) if s.name == "rm"][0]
    assert "confirm" in dspec.input_schema["properties"]
    print("8) confirm prop injected: OK")

    # rm is Deny on Channel -> hidden from tool_specs on Channel
    ch_names = [s.name for s in reg.tool_specs(Surface.Channel)]
    assert "rm" not in ch_names, ch_names
    assert "echo" in ch_names, ch_names
    print("9) tool_specs surface filtering (rm hidden on Channel): OK")


def test_stream_and_errors() -> None:
    reg = CapabilityRegistry()

    class StreamArgs(BM):
        n: int

    events: list = []

    @capability(name="gen", domain="test", danger=DangerTier.Read, summary="gen", stream=True, registry=reg)
    def gen(ctx: CallerCtx, args: StreamArgs, sink) -> dict:
        for i in range(args.n):
            sink({"i": i})
        return {"count": args.n}

    r = reg.dispatch_stream("gen", {"n": 3}, CallerCtx(), lambda e: events.append(e))
    assert r == {"count": 3}, r
    assert events == [{"i": 0}, {"i": 1}, {"i": 2}], events
    print("10) dispatch_stream: OK ->", r, "events:", events)

    # unknown capability
    assert reg.dispatch("nope", {}, CallerCtx()) == {"error": "unknown capability: 'nope'"}
    print("11) unknown capability: OK")

    # validation error (missing required path)
    @capability(name="rm2", domain="test", danger=DangerTier.Destructive, summary="del", registry=reg)
    def rm2(ctx: CallerCtx, args: StreamArgs) -> dict:
        return {"deleted": args.n}

    r = reg.dispatch("rm2", {}, CallerCtx(), )
    # needs confirmation first (destructive on desktop, unconfirmed)
    assert r == {"needs_confirmation": True}, r
    r = reg.dispatch("rm2", {"confirm": True}, CallerCtx())
    assert "error" in r and "invalid arguments" in r["error"], r
    print("12) validation error after confirm: OK")


def main() -> None:
    print("1) import OK")
    test_matrix()
    test_decide_overrides()
    test_surface()
    test_decorator_and_dispatch()
    test_stream_and_errors()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
