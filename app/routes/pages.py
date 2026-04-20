from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

from app.config import DATABASE_URL
from app.templates.render import render_console_page, render_docs_page


router = APIRouter()
TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"
ALLOWED_ASSET_NAMES = {"style.css", "console.js", "detail.js", "purify.min.js"}


@router.get("/", response_class=HTMLResponse)
def handle_home_page() -> HTMLResponse:
    """返回邮件控制台首页。"""
    return HTMLResponse(render_console_page())


@router.get("/docs", response_class=HTMLResponse)
def handle_docs_page() -> HTMLResponse:
    """返回项目文档页。"""
    return HTMLResponse(render_docs_page())


@router.get("/detail", response_class=HTMLResponse)
def handle_detail_page() -> HTMLResponse:
    """返回邮件详情页。"""
    from app.templates.render import render_detail_page
    return HTMLResponse(render_detail_page())


@router.get("/assets/{asset_name}")
def handle_template_asset(asset_name: str) -> FileResponse:
    """返回页面允许访问的静态资源文件。

    Args:
        asset_name: 浏览器请求的静态资源文件名。

    Returns:
        FileResponse: 可缓存的前端静态资源响应。

    Notes:
        仅暴露白名单资源，避免模板目录中的 HTML 文件被直接访问。
    """
    if asset_name not in ALLOWED_ASSET_NAMES:
        raise HTTPException(status_code=404, detail="Asset not found.")
    return FileResponse(
        TEMPLATES_DIR / asset_name,
        # 这些资源文件更新频率低，给浏览器一个短缓存窗口，减少重复请求。
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/healthz")
def handle_health() -> dict[str, bool]:
    """返回服务健康状态。"""
    return {"ok": True, "databaseConfigured": bool(DATABASE_URL)}
