from __future__ import annotations

from fastapi import HTTPException, Request

from app.config import API_TOKEN


def parse_bearer_token(value: str | None) -> str:
    """从 Authorization 头中提取 Bearer Token。"""
    header = value or ""
    prefix = "Bearer "
    return header[len(prefix):].strip() if header.startswith(prefix) else ""


def ensure_bearer(request: Request, expected: str, label: str) -> None:
    """校验请求中的 Bearer Token 是否与预期值一致。"""
    token = parse_bearer_token(request.headers.get("Authorization"))
    if not token or token != expected:
        raise HTTPException(status_code=401, detail=f"Unauthorized {label}.")


def require_api_token(request: Request) -> None:
    """校验所有 API 路由使用的 API Token。"""
    ensure_bearer(request, API_TOKEN, "API token")
