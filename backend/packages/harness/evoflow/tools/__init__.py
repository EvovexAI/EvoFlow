__all__ = ["get_available_tools"]


def __getattr__(name: str):
    if name == "get_available_tools":
        from .tools import get_available_tools

        return get_available_tools
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
