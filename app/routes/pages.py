from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.config import DATABASE_URL
from app.templates.render import render_console_page, render_docs_page


router = APIRouter()


@router.get("/", response_class=HTMLResponse)
def handle_home_page() -> HTMLResponse:
    """返回邮件控制台首页。"""
    return HTMLResponse(render_console_page())


@router.get("/docs", response_class=HTMLResponse)
def handle_docs_page() -> HTMLResponse:
    """返回项目文档页。"""
    return HTMLResponse(render_docs_page())


@router.get("/healthz")
def handle_health() -> dict[str, bool]:
    """返回服务健康状态。"""
    return {"ok": True, "databaseConfigured": bool(DATABASE_URL)}
