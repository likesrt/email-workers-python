from __future__ import annotations

import os
from pathlib import Path


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


def _parse_env_line(line: str) -> tuple[str, str] | None:
    """解析单行 .env 配置并忽略空行、注释与非法内容。"""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[7:].strip()
    if "=" not in stripped:
        return None
    name, value = stripped.split("=", 1)
    return name.strip(), value.strip().strip("\"'")


def _load_dotenv_if_exists() -> None:
    """在项目根目录存在 .env 时补充加载未显式设置的环境变量。"""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        parsed = _parse_env_line(line)
        if not parsed:
            continue
        name, value = parsed
        os.environ.setdefault(name, value)


# 优先保留当前进程环境变量，其次读取项目根目录中的 .env。
_load_dotenv_if_exists()

# 运行所需环境变量：统一 API Token 与 PostgreSQL 连接串。
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
API_TOKEN = os.getenv("API_TOKEN", "").strip()
# 附件存储根目录，默认 ./attachments，可通过环境变量覆盖。
ATTACHMENTS_DIR = os.path.abspath(os.getenv("ATTACHMENTS_DIR", "./attachments"))

# AI 识别配置（可选）。
AI_EXTRACTION_ENABLED = os.getenv("AI_EXTRACTION_ENABLED", "false").lower() == "true"
AI_PROVIDER = os.getenv("AI_PROVIDER", "openai")
AI_BASE_URL = os.getenv("AI_BASE_URL", "").strip()
AI_API_KEY = os.getenv("AI_API_KEY", "").strip()
AI_MODEL = os.getenv("AI_MODEL", "gpt-4").strip()
AI_TIMEOUT = int(os.getenv("AI_TIMEOUT", "10"))


def ensure_settings() -> None:
    """校验服务运行所需的关键环境变量是否已配置。"""
    for name, value in (("DATABASE_URL", DATABASE_URL), ("API_TOKEN", API_TOKEN)):
        if not value:
            raise RuntimeError(f"Missing required environment variable: {name}")
