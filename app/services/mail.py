from __future__ import annotations

import logging
from json import dumps
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from app.config import (
    AI_API_KEY,
    AI_BASE_URL,
    AI_EXTRACTION_ENABLED,
    AI_MODEL,
    AI_PROVIDER,
    AI_RETRY_TIMES,
    AI_TIMEOUT,
    DEFAULT_PAGE,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    MAX_RAW_TEXT_LENGTH,
)
from app.database import get_connection
from app.mail_parser import (
    extract_and_save_attachments,
    extract_date_header,
    extract_header_address,
    extract_header_map,
    extract_mail_bodies,
    extract_message_id,
    extract_subject,
    is_valid_email_address,
    normalize_email_address,
    parse_raw_message,
)
from app.models import IngestEmailRequest, MailListFilters
from app.services.attachments import insert_attachments
from app.services.code_extractor import extract_code_and_url, sanitize_extraction_result
from app.sql import (
    SQL_INSERT_MAIL,
    SQL_MARK_MAIL_EXTRACTION_PENDING,
    SQL_UPDATE_MAIL_EXTRACTION_RESULT,
    TABLE_MAILS,
)
from app.utils import isoformat_value, parse_datetime_filter, parse_positive_integer, truncate_text


logger = logging.getLogger(__name__)


def build_where_clause(filters: MailListFilters) -> tuple[str, list[Any]]:
    """
    根据查询条件构造 SQL WHERE 片段与绑定参数。

    Args:
        filters: 邮件列表查询过滤条件

    Returns:
        WHERE SQL 片段和绑定参数列表
    """
    conditions: list[str] = []
    values: list[Any] = []
    if filters.rcptTo:
        conditions.append("rcpt_to = %s")
        values.append(filters.rcptTo)
    if filters.after:
        conditions.append("received_at >= %s")
        values.append(filters.after)
    if filters.before:
        conditions.append("received_at <= %s")
        values.append(filters.before)
    return (f"WHERE {' AND '.join(conditions)}" if conditions else "", values)


def parse_filters(
    rcpt_to: str | None,
    after: str | None,
    before: str | None,
    page: int | None,
    page_size: int | None,
) -> MailListFilters:
    """
    解析并校验邮件列表查询参数。

    Args:
        rcpt_to: 收件邮箱筛选值
        after: 开始时间筛选值
        before: 结束时间筛选值
        page: 页码
        page_size: 每页条数

    Returns:
        规范化后的查询条件对象
    """
    address = normalize_email_address(rcpt_to or "")
    if address and not is_valid_email_address(address):
        raise HTTPException(status_code=400, detail="Invalid 'rcptTo' email address.")
    after_value = parse_datetime_filter(after, "after")
    before_value = parse_datetime_filter(before, "before")
    if after_value and before_value and after_value > before_value:
        raise HTTPException(
            status_code=400, detail="'after' must be less than or equal to 'before'."
        )
    return MailListFilters(
        rcptTo=address,
        after=after_value,
        before=before_value,
        page=parse_positive_integer(page, DEFAULT_PAGE, 1, 10**9),
        pageSize=parse_positive_integer(page_size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    )


def map_mail_summary(row: dict[str, Any]) -> dict[str, Any]:
    """
    将数据库行映射为邮件列表摘要结构。

    Args:
        row: 数据库查询结果行

    Returns:
        邮件摘要字典，包含已持久化的验证码和激活链接
    """
    return {
        "id": str(row["id"]),
        "messageId": str(row["message_id"]),
        "from": str(row["mail_from"]),
        "to": str(row["rcpt_to"]),
        "subject": str(row["subject"]),
        "date": str(row["date_header"]),
        "receivedAt": isoformat_value(row["received_at"]),
        "verificationCode": row.get("verification_code"),
        "activationUrl": row.get("activation_url"),
        "extractionStatus": str(row.get("extraction_status") or "pending"),
        "extractionError": str(row.get("extraction_error") or ""),
        "extractedAt": isoformat_value(row.get("extracted_at")),
    }


def map_mail_detail(row: dict[str, Any]) -> dict[str, Any]:
    """
    将数据库行映射为邮件详情结构。

    Args:
        row: 数据库查询结果行

    Returns:
        邮件详情字典
    """
    raw_text = str(row.get("raw_text") or "")
    bodies = extract_mail_bodies(raw_text)
    return {
        "id": str(row["id"]),
        "messageId": str(row["message_id"]),
        "from": str(row["mail_from"]),
        "to": str(row["rcpt_to"]),
        "subject": str(row["subject"]),
        "date": str(row["date_header"]),
        "receivedAt": isoformat_value(row["received_at"]),
        "verificationCode": row.get("verification_code"),
        "activationUrl": row.get("activation_url"),
        "extractionStatus": str(row.get("extraction_status") or "pending"),
        "extractionError": str(row.get("extraction_error") or ""),
        "extractedAt": isoformat_value(row.get("extracted_at")),
        "headers": row.get("headers_json") or {},
        "raw": raw_text,
        "textBody": bodies["textBody"],
        "htmlBody": bodies["htmlBody"],
    }


def count_mails(filters: MailListFilters) -> int:
    """
    统计满足条件的邮件总数。

    Args:
        filters: 邮件列表查询过滤条件

    Returns:
        满足条件的邮件总数
    """
    where_sql, values = build_where_clause(filters)
    sql = f"SELECT COUNT(*) AS total FROM {TABLE_MAILS} {where_sql};"
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, values)
            row = cur.fetchone() or {"total": 0}
    return int(row["total"] or 0)


def list_mails(filters: MailListFilters) -> list[dict[str, Any]]:
    """
    按分页条件查询邮件列表。

    Args:
        filters: 查询过滤条件（收件邮箱、时间范围、分页参数）

    Returns:
        邮件摘要列表，直接返回数据库中的识别结果
    """
    where_sql, values = build_where_clause(filters)
    offset = (filters.page - 1) * filters.pageSize
    sql = f"""
    SELECT id, message_id, mail_from, rcpt_to, subject, date_header, received_at,
           verification_code, activation_url, extraction_status
    FROM {TABLE_MAILS} {where_sql}
    ORDER BY received_at DESC, id DESC
    LIMIT %s OFFSET %s;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [*values, filters.pageSize, offset])
            rows = cur.fetchall() or []
    return [map_mail_summary(row) for row in rows]


def get_mail_by_id(mail_id: str) -> dict[str, Any] | None:
    """
    根据邮件 ID 查询单封邮件详情。

    Args:
        mail_id: 邮件主键 ID

    Returns:
        邮件详情行，不存在时返回 None
    """
    sql = f"""
    SELECT id, message_id, mail_from, rcpt_to, subject, date_header,
           received_at, headers_json, raw_text, verification_code,
           activation_url, extraction_status, extraction_error, extracted_at
    FROM {TABLE_MAILS} WHERE id = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [mail_id])
            return cur.fetchone()


def get_mail_by_id_and_address(address: str, mail_id: str) -> dict[str, Any] | None:
    """
    根据收件邮箱和邮件 ID 查询单封邮件详情。

    Args:
        address: 收件邮箱
        mail_id: 邮件主键 ID

    Returns:
        邮件详情行，不存在时返回 None
    """
    sql = f"""
    SELECT id, message_id, mail_from, rcpt_to, subject, date_header,
           received_at, headers_json, raw_text
    FROM {TABLE_MAILS} WHERE rcpt_to = %s AND id = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [address, mail_id])
            return cur.fetchone()


def upsert_mail(payload: IngestEmailRequest) -> dict[str, Any]:
    """
    解析原始邮件后写入或更新数据库，并提取附件落盘。

    Args:
        payload: Worker 推送的邮件数据

    Returns:
        包含邮件 ID、首次插入标记、主题和原始文本的结果字典
    """
    rcpt_to = normalize_email_address(payload.rcptTo)
    if not is_valid_email_address(rcpt_to):
        raise HTTPException(status_code=400, detail="Invalid recipient address.")
    raw_text = truncate_text(payload.rawText or "", MAX_RAW_TEXT_LENGTH)
    message = parse_raw_message(raw_text)
    params = _build_mail_params(payload, rcpt_to, message, raw_text)
    with get_connection() as conn:
        mail_row = _upsert_mail_row(conn, params)
        mail_id = str(mail_row["id"])
        inserted = mail_id == params["id"]
        if inserted:
            _mark_mail_extraction_pending(conn, mail_id)
        _save_mail_attachments(conn, mail_id, payload.rawText or "")
        conn.commit()
    return {
        "id": mail_id,
        "inserted": inserted,
        "subject": params["subject"],
        "rawText": raw_text,
    }


def _build_mail_params(
    payload: IngestEmailRequest, rcpt_to: str, message: Any, raw_text: str
) -> dict[str, Any]:
    """
    构造写入邮件所需的参数。

    Args:
        payload: Worker 推送的邮件数据
        rcpt_to: 规范化后的收件邮箱
        message: 已解析的邮件对象
        raw_text: 截断后的原始邮件文本

    Returns:
        可直接用于 SQL 写入的参数字典
    """
    return {
        "id": str(uuid4()),
        "message_id": extract_message_id(message),
        "mail_from": extract_header_address(message, "From")
        or normalize_email_address(payload.mailFrom),
        "rcpt_to": rcpt_to,
        "subject": extract_subject(message),
        "date_header": extract_date_header(message),
        "received_at": payload.receivedAt,
        "headers_json": dumps(extract_header_map(message), ensure_ascii=False),
        "raw_text": raw_text,
        "verification_code": None,
        "activation_url": None,
        "extraction_status": "pending",
        "extraction_error": "",
        "extraction_attempts": 0,
        "extracted_at": None,
    }


def _upsert_mail_row(conn: Any, params: dict[str, Any]) -> dict[str, Any]:
    """
    执行邮件写入并返回邮件主键和插入标记。

    Args:
        conn: 当前事务连接
        params: 邮件写入参数

    Returns:
        包含邮件 ID 和 inserted 标记的结果字典
    """
    with conn.cursor() as cur:
        cur.execute(SQL_INSERT_MAIL, params)
        return cur.fetchone() or {"id": params["id"]}


def _mark_mail_extraction_pending(conn: Any, mail_id: str) -> None:
    """
    将邮件识别状态标记为待处理。

    Args:
        conn: 当前事务连接
        mail_id: 邮件主键 ID

    Returns:
        None
    """
    with conn.cursor() as cur:
        cur.execute(SQL_MARK_MAIL_EXTRACTION_PENDING, [mail_id])


def _save_mail_attachments(conn: Any, mail_id: str, raw_text: str) -> None:
    """
    提取附件并在同一事务内写入元数据。

    Args:
        conn: 当前事务连接
        mail_id: 邮件主键 ID
        raw_text: 原始邮件文本

    Returns:
        None
    """
    attachments = extract_and_save_attachments(mail_id, raw_text)
    insert_attachments(conn, attachments)


def run_mail_extraction_job(mail_id: str, subject: str, raw_text: str) -> None:
    """
    在后台任务中执行邮件识别并回写数据库。

    Args:
        mail_id: 邮件主键 ID
        subject: 邮件主题
        raw_text: 原始邮件文本

    Returns:
        None
    """
    _run_extraction_job(mail_id, subject, raw_text)


def retry_mail_extraction(mail_id: str) -> dict[str, Any]:
    """
    重置指定邮件的识别状态并返回当前摘要。

    Args:
        mail_id: 邮件主键 ID

    Returns:
        已重置为待识别状态的邮件摘要

    Raises:
        HTTPException: 邮件不存在时抛出 404
    """
    mail = get_mail_by_id(mail_id)
    if not mail:
        raise HTTPException(status_code=404, detail="Mail not found.")
    _mark_mail_extraction_pending_by_id(mail_id)
    refreshed = get_mail_by_id(mail_id)
    if not refreshed:
        raise HTTPException(status_code=404, detail="Mail not found.")
    return map_mail_summary(refreshed)


def _mark_mail_extraction_pending_by_id(mail_id: str) -> None:
    """
    按邮件 ID 单独重置识别状态。

    Args:
        mail_id: 邮件主键 ID

    Returns:
        None
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(SQL_MARK_MAIL_EXTRACTION_PENDING, [mail_id])
        conn.commit()


def _run_extraction_job(mail_id: str, subject: str, raw_text: str) -> None:
    """
    执行一次完整的邮件识别作业。

    Args:
        mail_id: 邮件主键 ID
        subject: 邮件主题
        raw_text: 原始邮件文本

    Returns:
        None
    """
    logger.info("Start mail extraction. mail_id=%s", mail_id)
    try:
        result = _extract_code_and_url_with_fallback(mail_id, subject, raw_text)
        _save_extraction_result(mail_id, result, "done", "")
        logger.info(
            "Finish mail extraction. mail_id=%s code=%s url=%s",
            mail_id,
            bool(result.get("code")),
            bool(result.get("url")),
        )
    except Exception as exc:
        _save_extraction_result(
            mail_id,
            {"code": None, "url": None, "attempts": 0},
            "failed",
            str(exc),
        )
        logger.exception("Mail extraction failed. mail_id=%s", mail_id)


def _extract_code_and_url_with_fallback(
    mail_id: str, subject: str, raw_text: str
) -> dict[str, str | int | None]:
    """
    提取验证码和 URL，优先使用 AI，失败或无效时回退到规则提取。

    Args:
        mail_id: 邮件主键 ID
        subject: 邮件主题
        raw_text: 邮件原始文本

    Returns:
        包含 code、url 和 attempts 的字典
    """
    if AI_EXTRACTION_ENABLED and AI_BASE_URL and AI_API_KEY:
        try:
            from app.services.ai_extractor import extract_with_ai

            body_text = _extract_body_for_ai(raw_text)
            config = {
                "provider": AI_PROVIDER,
                "base_url": AI_BASE_URL,
                "api_key": AI_API_KEY,
                "model": AI_MODEL,
                "timeout": AI_TIMEOUT,
                "retry_times": AI_RETRY_TIMES,
            }
            logger.info("Start AI mail extraction. mail_id=%s provider=%s", mail_id, AI_PROVIDER)
            result = extract_with_ai(subject, body_text, config)
            sanitized = sanitize_extraction_result(subject, raw_text, result)
            if sanitized.get("code") or sanitized.get("url"):
                logger.info(
                    "AI mail extraction matched. mail_id=%s code=%s url=%s",
                    mail_id,
                    bool(sanitized.get("code")),
                    bool(sanitized.get("url")),
                )
                return {**sanitized, "attempts": AI_RETRY_TIMES + 1}
            logger.info("AI mail extraction returned no valid result. mail_id=%s", mail_id)
        except Exception:
            logger.exception("AI mail extraction crashed. mail_id=%s", mail_id)
    rule_result = extract_code_and_url(subject, raw_text)
    logger.info(
        "Rule mail extraction finished. mail_id=%s code=%s url=%s",
        mail_id,
        bool(rule_result.get("code")),
        bool(rule_result.get("url")),
    )
    return {**rule_result, "attempts": 1}


def _extract_body_for_ai(raw_text: str) -> str:
    """
    从原始邮件中提取正文用于 AI 识别。

    Args:
        raw_text: 邮件原始文本

    Returns:
        可读正文文本
    """
    bodies = extract_mail_bodies(raw_text)
    text_body = bodies.get("textBody", "")
    if text_body:
        return text_body
    html_body = bodies.get("htmlBody", "")
    if html_body:
        import re

        return re.sub(r"<[^>]+>", " ", html_body)
    return ""


def _save_extraction_result(
    mail_id: str,
    result: dict[str, str | int | None],
    status: str,
    error: str,
) -> None:
    """
    将识别结果写回邮件主表。

    Args:
        mail_id: 邮件主键 ID
        result: 提取结果字典
        status: 识别状态
        error: 错误信息

    Returns:
        None
    """
    attempts = int(result.get("attempts") or 0)
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                SQL_UPDATE_MAIL_EXTRACTION_RESULT,
                [
                    result.get("code"),
                    result.get("url"),
                    status,
                    error[:500],
                    attempts,
                    mail_id,
                ],
            )
        conn.commit()
