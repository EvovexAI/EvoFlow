"""EvoPanel client presence — backend stops panel runs on client restart."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.gateway.client_presence import attach_client_instance

router = APIRouter(prefix="/api/client", tags=["client"])


class ClientAttachRequest(BaseModel):
    client_instance_id: str = Field(..., min_length=8, max_length=128)


@router.post("/attach")
async def attach_client(body: ClientAttachRequest) -> dict:
    try:
        return await attach_client_instance(body.client_instance_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
