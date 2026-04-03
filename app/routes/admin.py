from __future__ import annotations

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from app.auth import require_api_token
from app.models import AutoCleanupConfigRequest, CleanupHistoryRequest
from app.services.cleanup import (
    build_auto_cleanup_response,
    delete_mails_before,
    get_manual_cleanup_cutoff,
    replace_auto_cleanup_task,
    save_auto_cleanup_state,
    validate_cleanup_interval,
)
from app.utils import isoformat_value


router = APIRouter()


@router.get("/api/admin/auto-cleanup")
def handle_get_auto_cleanup_config(request: Request) -> dict[str, object]:
    """返回当前自动清理配置。"""
    require_api_token(request)
    return build_auto_cleanup_response(request.app.state.auto_cleanup)


@router.put("/api/admin/auto-cleanup")
async def handle_update_auto_cleanup_config(
    request: Request,
    payload: AutoCleanupConfigRequest,
) -> dict[str, object]:
    """更新后端自动清理配置。"""
    require_api_token(request)
    state = request.app.state.auto_cleanup
    state["enabled"] = bool(payload.enabled)
    state["intervalMinutes"] = validate_cleanup_interval(payload.intervalMinutes)
    saved = await run_in_threadpool(save_auto_cleanup_state, state)
    state.update(saved)
    await replace_auto_cleanup_task(state)
    return build_auto_cleanup_response(state)


@router.post("/api/admin/cleanup-history")
def handle_cleanup_history_mails(
    request: Request,
    payload: CleanupHistoryRequest | None = None,
) -> dict[str, object]:
    """手动清理指定时间之前的历史邮件。"""
    require_api_token(request)
    before_value = get_manual_cleanup_cutoff(payload.before if payload else None)
    deleted_count = delete_mails_before(before_value)
    return {
        "success": True,
        "before": isoformat_value(before_value),
        "deletedCount": deleted_count,
    }
