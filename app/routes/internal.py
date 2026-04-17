from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Request

from app.auth import require_api_token
from app.models import IngestEmailRequest
from app.services.mail import run_mail_extraction_job, upsert_mail


router = APIRouter()


@router.post("/internal/emails")
def handle_ingest_email(
    payload: IngestEmailRequest,
    request: Request,
    background_tasks: BackgroundTasks,
) -> dict[str, object]:
    """
    接收 Worker 推送的邮件并写入数据库。

    Args:
        payload: Worker 推送的邮件数据
        request: 当前 HTTP 请求对象
        background_tasks: FastAPI 后台任务调度器

    Returns:
        写入结果，包含邮件 ID 和是否首次入库
    """
    require_api_token(request)
    result = upsert_mail(payload)
    if result["inserted"]:
        background_tasks.add_task(
            run_mail_extraction_job,
            str(result["id"]),
            str(result["subject"]),
            str(result["rawText"]),
        )
    return {"ok": True, "id": result["id"], "inserted": result["inserted"]}
