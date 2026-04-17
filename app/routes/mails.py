from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from app.auth import require_api_token
from app.config import DEFAULT_PAGE, DEFAULT_PAGE_SIZE
from app.mail_parser import is_valid_email_address, normalize_email_address
from app.models import MailListFilters
from app.services.mail import (
    count_mails,
    get_mail_by_id,
    get_mail_by_id_and_address,
    get_mail_summary_by_id,
    list_mails,
    map_mail_detail,
    parse_filters,
    retry_mail_extraction,
    run_mail_extraction_job,
)


router = APIRouter()


@router.get("/api/auth/verify")
def handle_verify_api_token(request: Request) -> dict[str, str | bool]:
    """验证控制台使用的 API Token 是否有效。"""
    require_api_token(request)
    return {"ok": True, "message": "API token is valid."}


@router.get("/api/mails")
def handle_list_mails(
    request: Request,
    rcptTo: str | None = None,
    after: str | None = None,
    before: str | None = None,
    page: int | None = DEFAULT_PAGE,
    pageSize: int | None = DEFAULT_PAGE_SIZE,
) -> dict[str, object]:
    """按筛选条件查询邮件列表。"""
    require_api_token(request)
    filters = parse_filters(rcptTo, after, before, page, pageSize)
    return _build_mail_list_response(filters, after, before)


@router.get("/api/mails/{mail_id}")
def handle_get_mail_detail_by_id(mail_id: str, request: Request) -> dict[str, object]:
    """按邮件 ID 查询邮件详情。"""
    require_api_token(request)
    mail = get_mail_by_id(mail_id)
    if not mail:
        raise HTTPException(status_code=404, detail="Mail not found.")
    return map_mail_detail(mail)


@router.get("/api/mails/{mail_id}/summary")
def handle_get_mail_summary_by_id(mail_id: str, request: Request) -> dict[str, object]:
    """按邮件 ID 查询邮件摘要，供列表局部刷新使用。"""
    require_api_token(request)
    item = get_mail_summary_by_id(mail_id)
    if not item:
        raise HTTPException(status_code=404, detail="Mail not found.")
    return item


@router.post("/api/mails/{mail_id}/retry-extraction")
def handle_retry_mail_extraction(
    mail_id: str, request: Request, background_tasks: BackgroundTasks
) -> dict[str, object]:
    """按邮件 ID 重新执行验证码与激活链接识别。"""
    require_api_token(request)
    mail = get_mail_by_id(mail_id)
    if not mail:
        raise HTTPException(status_code=404, detail="Mail not found.")
    item = retry_mail_extraction(mail_id)
    background_tasks.add_task(
        run_mail_extraction_job,
        mail_id,
        str(mail["subject"]),
        str(mail.get("raw_text") or ""),
    )
    return item


@router.get("/api/mail/{email}")
def handle_list_mails_by_address(
    email: str,
    request: Request,
    after: str | None = None,
    before: str | None = None,
    page: int | None = DEFAULT_PAGE,
    pageSize: int | None = DEFAULT_PAGE_SIZE,
) -> dict[str, object]:
    """按收件邮箱查询邮件列表，兼容旧接口路径。"""
    require_api_token(request)
    filters = parse_filters(email, after, before, page, pageSize)
    return _build_mail_list_response(filters, after, before)


@router.get("/api/mail/{email}/{mail_id}")
def handle_get_mail_detail_by_address(
    email: str, mail_id: str, request: Request
) -> dict[str, object]:
    """按收件邮箱和邮件 ID 查询邮件详情，兼容旧接口路径。"""
    require_api_token(request)
    address = normalize_email_address(email)
    if not is_valid_email_address(address):
        raise HTTPException(status_code=400, detail="Invalid email address.")
    mail = get_mail_by_id_and_address(address, mail_id)
    if not mail:
        raise HTTPException(status_code=404, detail="Mail not found.")
    return map_mail_detail(mail)


def _build_mail_list_response(
    filters: MailListFilters, after: str | None, before: str | None
) -> dict[str, object]:
    """构造邮件列表接口响应。"""
    total = count_mails(filters)
    items = list_mails(filters)
    page_size = filters.pageSize
    total_pages = (total + page_size - 1) // page_size if total else 0
    return {
        "filters": {"rcptTo": filters.rcptTo, "after": after, "before": before},
        "page": filters.page,
        "pageSize": filters.pageSize,
        "total": total,
        "totalPages": total_pages,
        "items": items,
    }
