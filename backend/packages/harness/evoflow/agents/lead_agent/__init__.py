__all__ = ["make_lead_agent"]


def __getattr__(name: str):
    if name == "make_lead_agent":
        from .agent import make_lead_agent

        return make_lead_agent
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
