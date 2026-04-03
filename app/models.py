from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.config import DEFAULT_PAGE, DEFAULT_PAGE_SIZE


# Worker 推送给 FastAPI 的原始邮件写入模型。
class IngestEmailRequest(BaseModel):
    mailFrom: str = ""
    rcptTo: str
    receivedAt: datetime
    rawText: str = ""


# 手动清理接口请求体，before 为空时走默认清理窗口。
class CleanupHistoryRequest(BaseModel):
    before: datetime | None = None


# 自动清理配置请求体。
class AutoCleanupConfigRequest(BaseModel):
    enabled: bool
    intervalMinutes: int


# 统一承载列表查询条件，便于复用查询构造逻辑。
class MailListFilters(BaseModel):
    rcptTo: str = ""
    after: datetime | None = None
    before: datetime | None = None
    page: int = DEFAULT_PAGE
    pageSize: int = DEFAULT_PAGE_SIZE
