import os

from pydantic import BaseModel, Field


class GatewayConfig(BaseModel):
    """Configuration for the API Gateway."""

    host: str = Field(default="0.0.0.0", description="Host to bind the gateway server")
    port: int = Field(default=8001, description="Port to bind the gateway server")
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"], description="Allowed CORS origins")


_gateway_config: GatewayConfig | None = None


def get_gateway_config() -> GatewayConfig:
    """Get gateway config, loading from environment if available."""
    global _gateway_config
    if _gateway_config is None:
        cors_env = os.getenv("CORS_ORIGINS", "").strip()
        if cors_env:
            cors_origins = [o.strip() for o in cors_env.split(",") if o.strip()]
        else:
            # Default: allow Tauri desktop + local dev origins only (not "*")
            cors_origins = [
                "http://localhost:3000",
                "http://127.0.0.1:1420",
                "http://localhost:1420",
                "http://127.0.0.1:1421",
                "http://localhost:1421",
                "http://127.0.0.1:1521",
                "http://localhost:1521",
                "http://tauri.localhost",
                "tauri://localhost",
            ]
        _gateway_config = GatewayConfig(
            host=os.getenv("GATEWAY_HOST", "0.0.0.0"),
            port=int(os.getenv("GATEWAY_PORT", "8001")),
            cors_origins=cors_origins,
        )
    return _gateway_config
