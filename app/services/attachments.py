from __future__ import annotations

import os
from datetime import datetime
from typing import Any
from urllib.parse import quote

from app.config import ATTACHMENTS_DIR
from app.database import get_connection
from app.sql import SQL_INSERT_ATTACHMENT, TABLE_ATTACHMENTS, TABLE_MAILS


def insert_attachments(conn: Any, attachments: list[dict[str, Any]]) -> None:
    """批量写入附件元数据到数据库。"""
    if not attachments:
        return
    with conn.cursor() as cur:
        for item in attachments:
            cur.execute(
                SQL_INSERT_ATTACHMENT,
                _build_attachment_insert_values(item),
            )


def _build_attachment_insert_values(item: dict[str, Any]) -> list[Any]:
    """构造单条附件写入参数。"""
    return [
        item["id"],
        item["mail_id"],
        item["filename"],
        item["content_type"],
        item["content_id"],
        item["disposition"],
        item["size_bytes"],
        item["file_path"],
    ]


def list_attachments_by_mail(mail_id: str) -> list[dict[str, Any]]:
    """查询指定邮件的所有附件元数据。"""
    sql = f"""
    SELECT id, mail_id, filename, content_type, content_id, disposition,
           size_bytes, file_path, created_at
    FROM {TABLE_ATTACHMENTS} WHERE mail_id = %s ORDER BY created_at;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [mail_id])
            rows = cur.fetchall() or []
    return [map_attachment_row(row) for row in rows]


def map_attachment_row(row: dict[str, Any]) -> dict[str, Any]:
    """将数据库行映射为附件摘要结构。"""
    return {
        "id": str(row["id"]),
        "mailId": str(row["mail_id"]),
        "filename": str(row["filename"]),
        "contentType": str(row["content_type"]),
        "contentId": str(row.get("content_id") or ""),
        "disposition": str(row.get("disposition") or "attachment"),
        "sizeBytes": int(row["size_bytes"]),
        "downloadUrl": f"/api/attachments/{row['id']}/download",
    }


def get_attachment_by_id(attachment_id: str) -> dict[str, Any] | None:
    """查询单条附件元数据。"""
    sql = f"""
    SELECT id, mail_id, filename, content_type, content_id, disposition,
           size_bytes, file_path
    FROM {TABLE_ATTACHMENTS} WHERE id = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [attachment_id])
            return cur.fetchone()


def delete_attachment_files(file_paths: list[str]) -> None:
    """删除磁盘上的附件文件，忽略不存在的文件。"""
    for name in file_paths:
        path = os.path.join(ATTACHMENTS_DIR, name)
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def delete_attachments_before(before: datetime) -> list[str]:
    """查询并删除过期附件元数据，返回需删除的文件路径列表。"""
    sql = f"""
    DELETE FROM {TABLE_ATTACHMENTS}
    WHERE mail_id IN (SELECT id FROM {TABLE_MAILS} WHERE received_at < %s)
    RETURNING file_path;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [before])
            rows = cur.fetchall() or []
        conn.commit()
    return [str(row["file_path"]) for row in rows]


def build_content_disposition(filename: str) -> str:
    """构建兼容中文文件名的 Content-Disposition 头。"""
    ascii_name = filename.encode("ascii", "replace").decode("ascii")
    utf8_name = quote(filename, safe="")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}"


def stream_file(file_path: str, chunk_size: int = 64 * 1024):
    """以生成器方式流式读取文件内容。"""
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            yield chunk
