"""EvoFlow local app-server package."""

from evoflow.app_server.stdio_rpc import (
    PROTOCOL_VERSION,
    StdioAppServer,
    main_argv,
    serve_stdio,
    serve_tcp,
    serve_tcp_server,
)

__all__ = [
    "PROTOCOL_VERSION",
    "StdioAppServer",
    "main_argv",
    "serve_stdio",
    "serve_tcp",
    "serve_tcp_server",
]
