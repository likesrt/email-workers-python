from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.auth import require_api_token
from app.config import ATTACHMENTS_DIR
from app.services.attachments import (
    build_content_disposition,
    get_attachment_by_id,
    list_attachments_by_mail,
    stream_file,
)


router = APIRouter()


@router.get("/api/mails/{mail_id}/attachments")
def handle_list_attachments(mail_id: str, request: Request) -> dict[str, object]:
    """返回指定邮件的附件列表。"""
    require_api_token(request)
    items = list_attachments_by_mail(mail_id)
    return {"mailId": mail_id, "items": items}


@router.get("/api/attachments/{attachment_id}/download")
def handle_download_attachment(attachment_id: str, request: Request):
    """流式下载指定附件文件，支持中文文件名。"""
    require_api_token(request)
    row = get_attachment_by_id(attachment_id)
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    file_path = os.path.join(ATTACHMENTS_DIR, str(row["file_path"]))
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Attachment file missing.")
    headers = {"Content-Disposition": build_content_disposition(str(row["filename"]))}
    return StreamingResponse(
        content=stream_file(file_path),
        media_type=str(row["content_type"]),
        headers=headers,
    )
