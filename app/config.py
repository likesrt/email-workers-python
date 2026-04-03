from __future__ import annotations

import os

# 数据库表名常量。
TABLE_MAILS = "received_mails"
TABLE_AUTO_CLEANUP = "auto_cleanup_settings"
TABLE_ATTACHMENTS = "mail_attachments"
AUTO_CLEANUP_CONFIG_KEY = "default"

# 分页与长度限制。
DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100
MAX_RAW_TEXT_LENGTH = 128 * 1024
MAX_SINGLE_ATTACHMENT_BYTES = 100 * 1024 * 1024

# 清理相关默认值。
MANUAL_CLEANUP_DEFAULT_MINUTES = 24 * 60
AUTO_CLEANUP_DEFAULT_INTERVAL_MINUTES = 10
AUTO_CLEANUP_DEFAULT_BEFORE_MINUTES = 10

# 运行所需环境变量：统一 API Token 与 PostgreSQL 连接串。
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
API_TOKEN = os.getenv("API_TOKEN", "").strip()
# 附件存储根目录，默认 ./attachments，可通过环境变量覆盖。
ATTACHMENTS_DIR = os.path.abspath(os.getenv("ATTACHMENTS_DIR", "./attachments"))


def ensure_settings() -> None:
    """校验服务运行所需的关键环境变量是否已配置。"""
    for name, value in (("DATABASE_URL", DATABASE_URL), ("API_TOKEN", API_TOKEN)):
        if not value:
            raise RuntimeError(f"Missing required environment variable: {name}")
