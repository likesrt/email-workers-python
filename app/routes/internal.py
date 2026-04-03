from __future__ import annotations

from fastapi import APIRouter, Request

from app.auth import require_api_token
from app.models import IngestEmailRequest
from app.services.mail import upsert_mail


router = APIRouter()


@router.post("/internal/emails")
def handle_ingest_email(
    payload: IngestEmailRequest, request: Request
) -> dict[str, object]:
    """接收 Worker 推送的邮件并写入数据库。"""
    require_api_token(request)
    mail_id = upsert_mail(payload)
    return {"ok": True, "id": mail_id}
