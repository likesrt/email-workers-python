from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def isoformat_value(value: Any) -> str:
    """将时间值转换为统一的 UTC ISO 字符串。"""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value or "")


def truncate_text(value: str, max_length: int) -> str:
    """将超长文本截断到指定长度。"""
    if len(value) <= max_length:
        return value
    return value[:max_length]


def parse_positive_integer(
    value: int | None, fallback: int, minimum: int, maximum: int
) -> int:
    """将输入整数约束到指定范围，非法时返回默认值。"""
    if value is None or value < minimum:
        return fallback
    return min(value, maximum)


def parse_datetime_filter(value: str | None, label: str) -> datetime | None:
    """解析 ISO 时间筛选参数，不合法时抛出 400 错误。"""
    if not value:
        return None
    from fastapi import HTTPException

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"Invalid '{label}' datetime."
        ) from exc
