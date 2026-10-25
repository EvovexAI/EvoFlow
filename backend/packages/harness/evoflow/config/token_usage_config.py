from typing import Any

from pydantic import BaseModel, Field, model_validator


class ModelPriceConfig(BaseModel):
    """Per-model price (USD per million tokens). Values default to 0 = unpriced."""

    input_per_mtok: float = Field(default=0.0, ge=0, description="USD per 1M input tokens (incl. cache write/read at face value)")
    output_per_mtok: float = Field(default=0.0, ge=0, description="USD per 1M output tokens")


class TokenUsageConfig(BaseModel):
    """Configuration for token usage tracking."""

    enabled: bool = Field(default=True, description="Enable token usage tracking middleware")
    pricing: dict[str, ModelPriceConfig] = Field(
        default_factory=dict,
        description=(
            "Model unit prices keyed by model name or fnmatch glob, e.g. "
            '`"glm-*": {input_per_mtok: 0.6, output_per_mtok: 2.2}`. '
            "Most specific (longest) matching pattern wins; unmatched models are unpriced (amount=0)."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _coerce_pricing(cls, data: Any) -> Any:
        """Accept shorthand pricing values (float = blended USD/MTok, raw dicts)."""
        if isinstance(data, dict) and "pricing" in data:
            data = {**data, "pricing": parse_pricing(data.get("pricing"))}
        return data

    def resolve_price(self, sku: str | None) -> ModelPriceConfig:
        """Resolve price for a model sku; longest glob/name match wins."""
        name = str(sku or "").strip()
        if not name or not self.pricing:
            return ModelPriceConfig()
        best_key = ""
        best: ModelPriceConfig | None = None
        for pattern, price in self.pricing.items():
            if not pattern:
                continue
            if pattern == name or glob_match(pattern, name):
                if len(pattern) >= len(best_key):
                    best_key = pattern
                    best = price
        return best or ModelPriceConfig()


def glob_match(pattern: str, name: str) -> bool:
    import fnmatch

    try:
        return fnmatch.fnmatch(name.lower(), pattern.lower())
    except Exception:
        return False


def parse_pricing(raw: Any) -> dict[str, ModelPriceConfig]:
    """Coerce yaml pricing dict into ModelPriceConfig values (accepts shorthand floats)."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, ModelPriceConfig] = {}
    for key, val in raw.items():
        if isinstance(val, ModelPriceConfig):
            out[str(key)] = val
        elif isinstance(val, (int, float)):
            # shorthand: single number = blended USD/MTok applied to both directions
            out[str(key)] = ModelPriceConfig(input_per_mtok=float(val), output_per_mtok=float(val))
        elif isinstance(val, dict):
            try:
                out[str(key)] = ModelPriceConfig(**val)
            except Exception:
                continue
    return out
