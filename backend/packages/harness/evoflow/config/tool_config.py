from pydantic import BaseModel, ConfigDict, Field


class ToolGroupConfig(BaseModel):
    """Config section for a tool group"""

    name: str = Field(..., description="Unique name for the tool group")
    model_config = ConfigDict(extra="allow")


class ToolConfig(BaseModel):
    """Config section for a tool"""

    name: str = Field(..., description="Unique name for the tool")
    # Legacy ACL bucket; unused after capability_pack / tools allowlist. Kept optional for old yaml.
    group: str = Field(default="", description="Deprecated tool group name (ignored)")
    use: str = Field(
        ...,
        description="Variable name of the tool provider(e.g. evoflow.sandbox.tools:bash_tool)",
    )
    model_config = ConfigDict(extra="allow")
