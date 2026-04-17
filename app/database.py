from __future__ import annotations

import os

import psycopg
from psycopg.rows import dict_row

from app.config import ATTACHMENTS_DIR, DATABASE_URL
from app.sql import (
    SQL_ALTER_ATTACHMENTS_ADD_CONTENT_ID,
    SQL_ALTER_ATTACHMENTS_ADD_DISPOSITION,
    SQL_ALTER_MAILS_ADD_ACTIVATION_URL,
    SQL_ALTER_MAILS_ADD_EXTRACTED_AT,
    SQL_ALTER_MAILS_ADD_EXTRACTION_ATTEMPTS,
    SQL_ALTER_MAILS_ADD_EXTRACTION_ERROR,
    SQL_ALTER_MAILS_ADD_EXTRACTION_STATUS,
    SQL_ALTER_MAILS_ADD_VERIFICATION_CODE,
    SQL_CREATE_ATTACHMENTS_TABLE,
    SQL_CREATE_AUTO_CLEANUP_TABLE,
    SQL_CREATE_INDEX_ATTACHMENTS_MAIL_ID,
    SQL_CREATE_INDEX_RCPT_TO_RECEIVED_AT,
    SQL_CREATE_INDEX_RECEIVED_AT,
    SQL_CREATE_TABLE,
)


def get_connection() -> psycopg.Connection:
    """
    创建 PostgreSQL 连接并使用字典行返回结果。

    Returns:
        可直接执行 SQL 的 PostgreSQL 连接
    """
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def _run_schema_sql(cur: psycopg.Cursor) -> None:
    """
    执行数据库初始化和兼容升级所需的全部 SQL。

    Args:
        cur: 当前事务内可执行 SQL 的游标

    Returns:
        None
    """
    cur.execute(SQL_CREATE_TABLE)
    cur.execute(SQL_CREATE_INDEX_RECEIVED_AT)
    cur.execute(SQL_CREATE_INDEX_RCPT_TO_RECEIVED_AT)
    cur.execute(SQL_CREATE_AUTO_CLEANUP_TABLE)
    cur.execute(SQL_CREATE_ATTACHMENTS_TABLE)
    cur.execute(SQL_ALTER_ATTACHMENTS_ADD_CONTENT_ID)
    cur.execute(SQL_ALTER_ATTACHMENTS_ADD_DISPOSITION)
    cur.execute(SQL_ALTER_MAILS_ADD_VERIFICATION_CODE)
    cur.execute(SQL_ALTER_MAILS_ADD_ACTIVATION_URL)
    cur.execute(SQL_ALTER_MAILS_ADD_EXTRACTION_STATUS)
    cur.execute(SQL_ALTER_MAILS_ADD_EXTRACTION_ERROR)
    cur.execute(SQL_ALTER_MAILS_ADD_EXTRACTION_ATTEMPTS)
    cur.execute(SQL_ALTER_MAILS_ADD_EXTRACTED_AT)
    cur.execute(SQL_CREATE_INDEX_ATTACHMENTS_MAIL_ID)


def ensure_schema() -> None:
    """
    初始化数据库表、索引和附件目录。

    Returns:
        None
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            _run_schema_sql(cur)
        conn.commit()
    os.makedirs(ATTACHMENTS_DIR, exist_ok=True)
