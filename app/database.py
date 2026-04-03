from __future__ import annotations

import os

import psycopg
from psycopg.rows import dict_row

from app.config import ATTACHMENTS_DIR
from app.sql import (
    SQL_ALTER_ATTACHMENTS_ADD_CONTENT_ID,
    SQL_ALTER_ATTACHMENTS_ADD_DISPOSITION,
    SQL_CREATE_ATTACHMENTS_TABLE,
    SQL_CREATE_AUTO_CLEANUP_TABLE,
    SQL_CREATE_INDEX_ATTACHMENTS_MAIL_ID,
    SQL_CREATE_INDEX_RCPT_TO_RECEIVED_AT,
    SQL_CREATE_INDEX_RECEIVED_AT,
    SQL_CREATE_TABLE,
)
from app.config import DATABASE_URL


def get_connection() -> psycopg.Connection:
    """创建 PostgreSQL 连接并使用字典行返回结果。"""
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def _run_schema_sql(cur: psycopg.Cursor) -> None:
    """执行数据库初始化所需的全部 SQL。"""
    cur.execute(SQL_CREATE_TABLE)
    cur.execute(SQL_CREATE_INDEX_RECEIVED_AT)
    cur.execute(SQL_CREATE_INDEX_RCPT_TO_RECEIVED_AT)
    cur.execute(SQL_CREATE_AUTO_CLEANUP_TABLE)
    cur.execute(SQL_CREATE_ATTACHMENTS_TABLE)
    cur.execute(SQL_ALTER_ATTACHMENTS_ADD_CONTENT_ID)
    cur.execute(SQL_ALTER_ATTACHMENTS_ADD_DISPOSITION)
    cur.execute(SQL_CREATE_INDEX_ATTACHMENTS_MAIL_ID)


def ensure_schema() -> None:
    """初始化数据库表和索引。"""
    with get_connection() as conn:
        with conn.cursor() as cur:
            _run_schema_sql(cur)
        conn.commit()
    os.makedirs(ATTACHMENTS_DIR, exist_ok=True)
