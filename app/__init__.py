from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.config import ensure_settings
from app.database import ensure_schema
from app.routes.admin import router as admin_router
from app.routes.attachments import router as attachments_router
from app.routes.internal import router as internal_router
from app.routes.mails import router as mails_router
from app.routes.pages import router as pages_router
from app.services.cleanup import load_auto_cleanup_state, replace_auto_cleanup_task


@asynccontextmanager
async def lifespan(app: FastAPI):
    """在应用启动时校验配置并初始化数据库结构。"""
    ensure_settings()
    ensure_schema()
    app.state.auto_cleanup = load_auto_cleanup_state()
    await replace_auto_cleanup_task(app.state.auto_cleanup)
    try:
        yield
    finally:
        await _stop_auto_cleanup_task(app.state.auto_cleanup)


async def _stop_auto_cleanup_task(state: dict[str, Any]) -> None:
    """在应用关闭时停止自动清理后台任务。"""
    task = state.get("task")
    if task:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(
    title="Mail Inbox Backend",
    docs_url="/openapi",
    redoc_url=None,
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.exception_handler(HTTPException)
def handle_http_error(_: Request, exc: HTTPException) -> JSONResponse:
    """将 HTTPException 统一转换为 error 字段响应。"""
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc.detail)})


@app.exception_handler(RequestValidationError)
def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    """将请求参数校验错误统一转换为 JSON 响应。"""
    return JSONResponse(status_code=422, content={"error": str(exc.errors())})


@app.exception_handler(Exception)
def handle_unknown_error(_: Request, exc: Exception) -> JSONResponse:
    """兜底处理未捕获异常。"""
    print(f"Unhandled error: {exc}")
    return JSONResponse(status_code=500, content={"error": "Internal server error."})


app.include_router(pages_router)
app.include_router(mails_router)
app.include_router(attachments_router)
app.include_router(admin_router)
app.include_router(internal_router)
