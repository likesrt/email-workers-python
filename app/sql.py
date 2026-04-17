from __future__ import annotations

from app.config import TABLE_ATTACHMENTS, TABLE_AUTO_CLEANUP, TABLE_MAILS

# 主表：同时保存邮件基础字段、原始内容、头信息和识别结果。
SQL_CREATE_TABLE = f"""
CREATE TABLE IF NOT EXISTS {TABLE_MAILS} (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  mail_from TEXT NOT NULL,
  rcpt_to TEXT NOT NULL,
  subject TEXT NOT NULL,
  date_header TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  headers_json JSONB NOT NULL,
  raw_text TEXT NOT NULL,
  verification_code TEXT,
  activation_url TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extraction_error TEXT NOT NULL DEFAULT '',
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  extracted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, rcpt_to)
);
"""

SQL_CREATE_INDEX_RECEIVED_AT = f"""
CREATE INDEX IF NOT EXISTS idx_{TABLE_MAILS}_received_at
ON {TABLE_MAILS} (received_at DESC);
"""

SQL_CREATE_INDEX_RCPT_TO_RECEIVED_AT = f"""
CREATE INDEX IF NOT EXISTS idx_{TABLE_MAILS}_rcpt_to_received_at
ON {TABLE_MAILS} (rcpt_to, received_at DESC);
"""

SQL_CREATE_AUTO_CLEANUP_TABLE = f"""
CREATE TABLE IF NOT EXISTS {TABLE_AUTO_CLEANUP} (
  config_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  interval_minutes INTEGER NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_deleted_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

# 附件表：记录元数据，文件本体落到磁盘。
SQL_CREATE_ATTACHMENTS_TABLE = f"""
CREATE TABLE IF NOT EXISTS {TABLE_ATTACHMENTS} (
  id TEXT PRIMARY KEY,
  mail_id TEXT NOT NULL REFERENCES {TABLE_MAILS}(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content_id TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL DEFAULT 'attachment',
  size_bytes INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

SQL_CREATE_INDEX_ATTACHMENTS_MAIL_ID = f"""
CREATE INDEX IF NOT EXISTS idx_{TABLE_ATTACHMENTS}_mail_id
ON {TABLE_ATTACHMENTS} (mail_id);
"""

SQL_ALTER_ATTACHMENTS_ADD_CONTENT_ID = f"""
ALTER TABLE {TABLE_ATTACHMENTS}
ADD COLUMN IF NOT EXISTS content_id TEXT NOT NULL DEFAULT '';
"""

SQL_ALTER_ATTACHMENTS_ADD_DISPOSITION = f"""
ALTER TABLE {TABLE_ATTACHMENTS}
ADD COLUMN IF NOT EXISTS disposition TEXT NOT NULL DEFAULT 'attachment';
"""

SQL_ALTER_MAILS_ADD_VERIFICATION_CODE = f"""
ALTER TABLE {TABLE_MAILS}
ADD COLUMN IF NOT EXISTS verification_code TEXT;
"""

SQL_ALTER_MAILS_ADD_ACTIVATION_URL = f"""
ALTER TABLE {TABLE_MAILS}
ADD COLUMN IF NOT EXISTS activation_url TEXT;
"""

SQL_ALTER_MAILS_ADD_EXTRACTION_STATUS = f"""
ALTER TABLE {TABLE_MAILS}
ADD COLUMN IF NOT EXISTS extraction_status TEXT NOT NULL DEFAULT 'pending';
"""

SQL_ALTER_MAILS_ADD_EXTRACTION_ERROR = f"""
ALTER TABLE {TABLE_MAILS}
ADD COLUMN IF NOT EXISTS extraction_error TEXT NOT NULL DEFAULT '';
"""

SQL_ALTER_MAILS_ADD_EXTRACTION_ATTEMPTS = f"""
ALTER TABLE {TABLE_MAILS}
ADD COLUMN IF NOT EXISTS extraction_attempts INTEGER NOT NULL DEFAULT 0;
"""

SQL_ALTER_MAILS_ADD_EXTRACTED_AT = f"""
ALTER TABLE {TABLE_MAILS}
ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ;
"""

SQL_INSERT_ATTACHMENT = f"""
INSERT INTO {TABLE_ATTACHMENTS} (
  id, mail_id, filename, content_type, content_id, disposition, size_bytes, file_path
)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (id) DO NOTHING;
"""

SQL_INSERT_MAIL = f"""
INSERT INTO {TABLE_MAILS} (
  id, message_id, mail_from, rcpt_to, subject,
  date_header, received_at, headers_json, raw_text,
  verification_code, activation_url, extraction_status,
  extraction_error, extraction_attempts, extracted_at
) VALUES (
  %(id)s, %(message_id)s, %(mail_from)s, %(rcpt_to)s, %(subject)s,
  %(date_header)s, %(received_at)s, %(headers_json)s::jsonb, %(raw_text)s,
  %(verification_code)s, %(activation_url)s, %(extraction_status)s,
  %(extraction_error)s, %(extraction_attempts)s, %(extracted_at)s
)
ON CONFLICT (message_id, rcpt_to) DO UPDATE SET
  mail_from = EXCLUDED.mail_from,
  subject = EXCLUDED.subject,
  date_header = EXCLUDED.date_header,
  received_at = EXCLUDED.received_at,
  headers_json = EXCLUDED.headers_json,
  raw_text = EXCLUDED.raw_text
RETURNING id;
"""

SQL_UPDATE_MAIL_EXTRACTION_RESULT = f"""
UPDATE {TABLE_MAILS}
SET verification_code = %s,
    activation_url = %s,
    extraction_status = %s,
    extraction_error = %s,
    extraction_attempts = %s,
    extracted_at = NOW()
WHERE id = %s;
"""

SQL_MARK_MAIL_EXTRACTION_PENDING = f"""
UPDATE {TABLE_MAILS}
SET extraction_status = 'pending',
    extraction_error = '',
    extraction_attempts = 0,
    extracted_at = NULL
WHERE id = %s;
"""
