from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from app.config import (
    AUTO_CLEANUP_CONFIG_KEY,
    AUTO_CLEANUP_DEFAULT_BEFORE_MINUTES,
    AUTO_CLEANUP_DEFAULT_INTERVAL_MINUTES,
    MANUAL_CLEANUP_DEFAULT_MINUTES,
)
from app.database import get_connection
from app.sql import TABLE_AUTO_CLEANUP, TABLE_MAILS
from app.utils import isoformat_value
from app.services.attachments import delete_attachment_files, delete_attachments_before


def create_auto_cleanup_state() -> dict[str, Any]:
    """创建自动清理运行状态。"""
    return {
        "enabled": False,
        "intervalMinutes": AUTO_CLEANUP_DEFAULT_INTERVAL_MINUTES,
        "task": None,
        "lastRunAt": "",
        "lastDeletedCount": 0,
    }


def create_default_auto_cleanup_config() -> dict[str, Any]:
    """创建自动清理默认配置。"""
    return {
        "enabled": False,
        "intervalMinutes": AUTO_CLEANUP_DEFAULT_INTERVAL_MINUTES,
        "lastRunAt": "",
        "lastDeletedCount": 0,
    }


def merge_auto_cleanup_state(saved: dict[str, Any]) -> dict[str, Any]:
    """将持久化配置合并为运行时状态。"""
    state = create_auto_cleanup_state()
    state.update(create_default_auto_cleanup_config())
    state.update(saved)
    state["enabled"] = bool(state["enabled"])
    state["intervalMinutes"] = validate_cleanup_interval(int(state["intervalMinutes"]))
    state["lastRunAt"] = str(state["lastRunAt"] or "")
    state["lastDeletedCount"] = int(state["lastDeletedCount"] or 0)
    state["task"] = None
    return state


def validate_cleanup_interval(minutes: int) -> int:
    """校验自动清理间隔分钟数。"""
    if minutes < 1:
        raise HTTPException(status_code=400, detail="intervalMinutes must be greater than 0.")
    return minutes


def get_cleanup_cutoff() -> datetime:
    """返回系统自动清理默认时间阈值。"""
    return datetime.now(timezone.utc) - timedelta(minutes=AUTO_CLEANUP_DEFAULT_BEFORE_MINUTES)


def get_manual_cleanup_cutoff(before: datetime | None) -> datetime:
    """返回手动清理使用的时间阈值。"""
    if before:
        return before
    return datetime.now(timezone.utc) - timedelta(minutes=MANUAL_CLEANUP_DEFAULT_MINUTES)


def build_auto_cleanup_response(state: dict[str, Any]) -> dict[str, Any]:
    """构造自动清理状态响应。"""
    return {
        "enabled": bool(state["enabled"]),
        "intervalMinutes": int(state["intervalMinutes"]),
        "beforeMinutes": AUTO_CLEANUP_DEFAULT_BEFORE_MINUTES,
        "lastRunAt": str(state["lastRunAt"] or ""),
        "lastDeletedCount": int(state["lastDeletedCount"] or 0),
    }


def load_auto_cleanup_state() -> dict[str, Any]:
    """从数据库加载自动清理配置。"""
    sql = f"""
    SELECT enabled, interval_minutes, last_run_at, last_deleted_count
    FROM {TABLE_AUTO_CLEANUP} WHERE config_key = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [AUTO_CLEANUP_CONFIG_KEY])
            row = cur.fetchone()
    if not row:
        return merge_auto_cleanup_state(create_default_auto_cleanup_config())
    return merge_auto_cleanup_state(_map_auto_cleanup_row(row))


def _map_auto_cleanup_row(row: dict[str, Any]) -> dict[str, Any]:
    """将数据库行映射为自动清理状态。"""
    return {
        "enabled": row["enabled"],
        "intervalMinutes": row["interval_minutes"],
        "lastRunAt": isoformat_value(row.get("last_run_at")),
        "lastDeletedCount": row["last_deleted_count"],
    }


def save_auto_cleanup_state(state: dict[str, Any]) -> dict[str, Any]:
    """将自动清理配置持久化到数据库。"""
    sql = f"""
    INSERT INTO {TABLE_AUTO_CLEANUP} (
      config_key, enabled, interval_minutes, last_run_at, last_deleted_count, updated_at
    ) VALUES (%s, %s, %s, %s, %s, NOW())
    ON CONFLICT (config_key) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      interval_minutes = EXCLUDED.interval_minutes,
      last_run_at = EXCLUDED.last_run_at,
      last_deleted_count = EXCLUDED.last_deleted_count,
      updated_at = NOW()
    RETURNING enabled, interval_minutes, last_run_at, last_deleted_count;
    """
    with get_connection() as conn:
        row = _save_auto_cleanup_row(conn, sql, state)
        conn.commit()
    return merge_auto_cleanup_state(_map_auto_cleanup_row(row))


def _save_auto_cleanup_row(conn: Any, sql: str, state: dict[str, Any]) -> dict[str, Any]:
    """执行自动清理配置写入。"""
    values = [
        AUTO_CLEANUP_CONFIG_KEY,
        bool(state["enabled"]),
        validate_cleanup_interval(int(state["intervalMinutes"])),
        state["lastRunAt"] or None,
        int(state["lastDeletedCount"] or 0),
    ]
    with conn.cursor() as cur:
        cur.execute(sql, values)
        row = cur.fetchone()
    return row or {
        "enabled": False,
        "interval_minutes": AUTO_CLEANUP_DEFAULT_INTERVAL_MINUTES,
        "last_run_at": None,
        "last_deleted_count": 0,
    }


def delete_mails_before(before: datetime) -> int:
    """删除指定时间之前的历史邮件并返回删除数量。"""
    file_paths = delete_attachments_before(before)
    sql = f"DELETE FROM {TABLE_MAILS} WHERE received_at < %s;"
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [before])
            deleted = cur.rowcount
        conn.commit()
    delete_attachment_files(file_paths)
    return int(deleted or 0)


async def run_auto_cleanup_once(state: dict[str, Any]) -> None:
    """执行一次后端自动清理任务。"""
    deleted = await run_in_threadpool(delete_mails_before, get_cleanup_cutoff())
    state["lastRunAt"] = isoformat_value(datetime.now(timezone.utc))
    state["lastDeletedCount"] = deleted
    saved = await run_in_threadpool(save_auto_cleanup_state, state)
    state.update(saved)


async def auto_cleanup_loop(state: dict[str, Any]) -> None:
    """按配置周期持续执行自动清理。"""
    while state["enabled"]:
        await asyncio.sleep(int(state["intervalMinutes"]) * 60)
        if state["enabled"]:
            await run_auto_cleanup_once(state)


async def replace_auto_cleanup_task(state: dict[str, Any]) -> None:
    """按当前状态重建自动清理后台任务。"""
    task = state.get("task")
    if task:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    state["task"] = asyncio.create_task(auto_cleanup_loop(state)) if state["enabled"] else None
