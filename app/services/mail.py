from __future__ import annotations

from json import dumps
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from app.config import DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_RAW_TEXT_LENGTH
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
from app.sql import SQL_INSERT_MAIL, TABLE_MAILS
from app.utils import isoformat_value, parse_datetime_filter, parse_positive_integer, truncate_text
from app.services.attachments import insert_attachments


def build_where_clause(filters: MailListFilters) -> tuple[str, list[Any]]:
    """根据查询条件构造 SQL WHERE 片段与绑定参数。"""
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
    """解析并校验邮件列表查询参数。"""
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
    """将数据库行映射为邮件列表摘要结构。"""
    return {
        "id": str(row["id"]),
        "messageId": str(row["message_id"]),
        "from": str(row["mail_from"]),
        "to": str(row["rcpt_to"]),
        "subject": str(row["subject"]),
        "date": str(row["date_header"]),
        "receivedAt": isoformat_value(row["received_at"]),
    }


def map_mail_detail(row: dict[str, Any]) -> dict[str, Any]:
    """将数据库行映射为邮件详情结构。"""
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
        "headers": row.get("headers_json") or {},
        "raw": raw_text,
        "textBody": bodies["textBody"],
        "htmlBody": bodies["htmlBody"],
    }


def count_mails(filters: MailListFilters) -> int:
    """统计满足条件的邮件总数。"""
    where_sql, values = build_where_clause(filters)
    sql = f"SELECT COUNT(*) AS total FROM {TABLE_MAILS} {where_sql};"
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, values)
            row = cur.fetchone() or {"total": 0}
    return int(row["total"] or 0)


def list_mails(filters: MailListFilters) -> list[dict[str, Any]]:
    """按分页条件查询邮件列表。"""
    where_sql, values = build_where_clause(filters)
    offset = (filters.page - 1) * filters.pageSize
    sql = f"""
    SELECT id, message_id, mail_from, rcpt_to, subject, date_header, received_at
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
    """根据邮件 ID 查询单封邮件详情。"""
    sql = f"""
    SELECT id, message_id, mail_from, rcpt_to, subject, date_header,
           received_at, headers_json, raw_text
    FROM {TABLE_MAILS} WHERE id = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [mail_id])
            return cur.fetchone()


def get_mail_by_id_and_address(address: str, mail_id: str) -> dict[str, Any] | None:
    """根据收件邮箱和邮件 ID 查询单封邮件详情。"""
    sql = f"""
    SELECT id, message_id, mail_from, rcpt_to, subject, date_header,
           received_at, headers_json, raw_text
    FROM {TABLE_MAILS} WHERE rcpt_to = %s AND id = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [address, mail_id])
            return cur.fetchone()


def upsert_mail(payload: IngestEmailRequest) -> str:
    """解析原始邮件后写入或更新数据库，并提取附件落盘。"""
    rcpt_to = normalize_email_address(payload.rcptTo)
    if not is_valid_email_address(rcpt_to):
        raise HTTPException(status_code=400, detail="Invalid recipient address.")
    raw_text = truncate_text(payload.rawText or "", MAX_RAW_TEXT_LENGTH)
    message = parse_raw_message(raw_text)
    params = _build_mail_params(payload, rcpt_to, message, raw_text)
    with get_connection() as conn:
        mail_id = _upsert_mail_row(conn, params)
        _save_mail_attachments(conn, mail_id, payload.rawText or "")
        conn.commit()
    return mail_id


def _build_mail_params(
    payload: IngestEmailRequest, rcpt_to: str, message: Any, raw_text: str
) -> dict[str, Any]:
    """构造写入邮件所需的参数。"""
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
    }


def _upsert_mail_row(conn: Any, params: dict[str, Any]) -> str:
    """执行邮件写入并返回邮件 ID。"""
    with conn.cursor() as cur:
        cur.execute(SQL_INSERT_MAIL, params)
        row = cur.fetchone() or {"id": params["id"]}
    return str(row["id"])


def _save_mail_attachments(conn: Any, mail_id: str, raw_text: str) -> None:
    """提取附件并在同一事务内写入元数据。"""
    attachments = extract_and_save_attachments(mail_id, raw_text)
    insert_attachments(conn, attachments)
