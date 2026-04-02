from __future__ import annotations

import asyncio
import os
import re
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from email import policy
from email.header import decode_header, make_header
from email.parser import Parser
from email.utils import parseaddr
from json import dumps
from typing import Any
from uuid import uuid4

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel
from psycopg.rows import dict_row
from starlette.concurrency import run_in_threadpool

# 数据库与查询相关常量。
TABLE_MAILS = "received_mails"
TABLE_AUTO_CLEANUP = "auto_cleanup_settings"
TABLE_ATTACHMENTS = "mail_attachments"
AUTO_CLEANUP_CONFIG_KEY = "default"
DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100
MAX_RAW_TEXT_LENGTH = 128 * 1024
MAX_SINGLE_ATTACHMENT_BYTES = 100 * 1024 * 1024   # 单个附件最大 10 MB
MANUAL_CLEANUP_DEFAULT_MINUTES = 24 * 60
AUTO_CLEANUP_DEFAULT_INTERVAL_MINUTES = 10
AUTO_CLEANUP_DEFAULT_BEFORE_MINUTES = 10

# 运行所需环境变量：统一 API Token 与 PostgreSQL 连接串。
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
API_TOKEN = os.getenv("API_TOKEN", "").strip()
# 附件存储根目录，默认 ./attachments，可通过环境变量覆盖。
ATTACHMENTS_DIR = os.path.abspath(os.getenv("ATTACHMENTS_DIR", "./attachments"))

# 主表：同时保存邮件基础字段、原始内容和头信息。
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
  size_bytes INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

SQL_CREATE_INDEX_ATTACHMENTS_MAIL_ID = f"""
CREATE INDEX IF NOT EXISTS idx_{TABLE_ATTACHMENTS}_mail_id
ON {TABLE_ATTACHMENTS} (mail_id);
"""

SQL_INSERT_ATTACHMENT = f"""
INSERT INTO {TABLE_ATTACHMENTS} (id, mail_id, filename, content_type, size_bytes, file_path)
VALUES (%s, %s, %s, %s, %s, %s)
ON CONFLICT (id) DO NOTHING;
"""

SQL_INSERT_MAIL = f"""
INSERT INTO {TABLE_MAILS} (
  id, message_id, mail_from, rcpt_to, subject,
  date_header, received_at, headers_json, raw_text
) VALUES (
  %(id)s, %(message_id)s, %(mail_from)s, %(rcpt_to)s, %(subject)s,
  %(date_header)s, %(received_at)s, %(headers_json)s::jsonb, %(raw_text)s
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


# 控制台与文档页共用样式，保持原有单页操作体验。
SHARED_PAGE_STYLE = r'''
    :root {
      --panel: rgba(9, 18, 34, 0.78);
      --panel-strong: rgba(6, 14, 27, 0.92);
      --line: rgba(148, 163, 184, 0.16);
      --line-strong: rgba(148, 163, 184, 0.28);
      --text: #f8fafc;
      --text-soft: #b7c4d8;
      --accent: #ff9f43;
      --accent-strong: #ff6b2c;
      --danger: #ff5d73;
      --success: #34d399;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      color-scheme: dark;
    }
    * {
      box-sizing: border-box;
    }
    html {
      min-height: 100%;
      background:
        radial-gradient(circle at top left, rgba(255, 159, 67, 0.16), transparent 30%),
        radial-gradient(circle at right 20%, rgba(79, 209, 197, 0.14), transparent 28%),
        linear-gradient(180deg, #08101d 0%, #050b14 100%);
    }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--text);
      line-height: 1.6;
      background: transparent;
    }
    button, input, select, textarea {
      font: inherit;
    }
    .page-shell {
      position: relative;
      overflow: hidden;
      min-height: 100vh;
    }
    .page-shell::before,
    .page-shell::after {
      content: "";
      position: absolute;
      border-radius: 999px;
      filter: blur(24px);
      opacity: 0.55;
      pointer-events: none;
    }
    .page-shell::before {
      width: 320px;
      height: 320px;
      top: 80px;
      right: -60px;
      background: rgba(255, 159, 67, 0.18);
      animation: drift 12s ease-in-out infinite;
    }
    .page-shell::after {
      width: 260px;
      height: 260px;
      bottom: 120px;
      left: -40px;
      background: rgba(79, 209, 197, 0.16);
      animation: drift 14s ease-in-out infinite reverse;
    }
    .wrap {
      position: relative;
      z-index: 1;
      max-width: 1360px;
      margin: 0 auto;
      padding: 32px 20px 40px;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(240px, 0.8fr);
      gap: 20px;
      margin-bottom: 20px;
      padding: 28px;
      background:
        linear-gradient(135deg, rgba(255, 159, 67, 0.12), transparent 42%),
        linear-gradient(160deg, rgba(79, 209, 197, 0.08), transparent 62%),
        var(--panel-strong);
    }
    .eyebrow {
      display: inline-flex;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255, 159, 67, 0.25);
      background: rgba(255, 159, 67, 0.12);
      color: #ffd6a8;
      font-size: 12px;
      letter-spacing: 0.18em;
    }
    h1, h2, h3 {
      margin: 0;
      letter-spacing: -0.02em;
    }
    h1 {
      margin-top: 14px;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(34px, 5vw, 58px);
      line-height: 1;
    }
    h2 {
      font-size: 24px;
    }
    .hero-copy {
      max-width: 760px;
    }
    .hero-text,
    .muted,
    .small,
    .section-note {
      color: var(--text-soft);
    }
    .hero-actions,
    .toolbar,
    .top-links,
    .meta-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .pagination {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 10px;
    }
    .hero-actions {
      margin-top: 18px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
      font-size: 12px;
      letter-spacing: 0.04em;
    }
    .panel-note {
      display: grid;
      gap: 10px;
      padding: 18px;
      border-radius: 22px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.04);
    }
    .panel-note strong {
      font-size: 24px;
    }
    .layout-grid {
      display: grid;
      gap: 20px;
    }
    .section-panel {
      padding: 24px;
      background: var(--panel);
    }
    .section-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: start;
      margin-bottom: 18px;
    }
    .section-head h2 {
      margin-bottom: 6px;
    }
    .section-tag {
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(79, 209, 197, 0.12);
      border: 1px solid rgba(79, 209, 197, 0.24);
      color: #baf4ee;
      font-size: 12px;
      white-space: nowrap;
    }
    .row {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 14px;
    }
    .field {
      display: grid;
      gap: 8px;
      grid-column: span 3;
      min-width: 0;
    }
    .field.wide {
      grid-column: span 6;
    }
    label {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.06em;
      color: rgba(255, 255, 255, 0.76);
      text-transform: uppercase;
    }
    input, select, textarea {
      width: 100%;
      min-height: 48px;
      padding: 12px 14px;
      border-radius: 16px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      outline: none;
      transition: border-color 0.2s ease, transform 0.2s ease,
        background-color 0.2s ease, box-shadow 0.2s ease;
    }
    input:focus,
    select:focus,
    textarea:focus {
      border-color: rgba(255, 159, 67, 0.62);
      background: rgba(255, 255, 255, 0.06);
      box-shadow: 0 0 0 4px rgba(255, 159, 67, 0.12);
      transform: translateY(-1px);
    }
    input::placeholder {
      color: rgba(183, 196, 216, 0.64);
    }
    button,
    .nav-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 46px;
      padding: 11px 16px;
      border-radius: 16px;
      border: 1px solid transparent;
      color: var(--text);
      cursor: pointer;
      white-space: nowrap;
      text-decoration: none;
      transition: transform 0.18s ease, box-shadow 0.18s ease,
        border-color 0.18s ease, opacity 0.18s ease;
    }
    button:hover,
    .nav-link:hover {
      transform: translateY(-1px);
    }
    .primary,
    .nav-link.primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      box-shadow: 0 12px 30px rgba(255, 107, 44, 0.28);
    }
    .secondary,
    .nav-link.secondary {
      border-color: var(--line);
      background: rgba(255, 255, 255, 0.05);
    }
    .danger {
      background: linear-gradient(135deg, #ff6d7d, var(--danger));
      box-shadow: 0 12px 30px rgba(255, 93, 115, 0.2);
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
    .status-shell {
      margin-top: 16px;
      padding: 14px 16px;
      border-radius: 18px;
      border: 1px solid rgba(79, 209, 197, 0.18);
      background: rgba(79, 209, 197, 0.08);
    }
    .status {
      min-height: 24px;
      font-size: 14px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .status[data-kind="error"] {
      color: #ffd2d8;
    }
    .status[data-kind="success"] {
      color: #c7ffe7;
    }
    .pagination .pill {
      min-height: 46px;
      padding: 11px 16px;
      border-radius: 16px;
      font-size: 14px;
      letter-spacing: 0;
    }
    .table-wrap {
      width: 100%;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      border-radius: 22px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.03);
    }
    table {
      width: 100%;
      min-width: 0;
      table-layout: fixed;
      border-collapse: collapse;
    }
    th, td {
      min-width: 0;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }
    th {
      position: sticky;
      top: 0;
      background: rgba(7, 17, 31, 0.96);
      color: rgba(255, 255, 255, 0.82);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 12px;
      z-index: 1;
    }
    tbody tr:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    .col-time {
      width: 180px;
    }
    .col-to {
      width: 180px;
    }
    .col-from {
      width: 200px;
    }
    .col-subject {
      width: 260px;
    }
    .col-message-id {
      width: 220px;
    }
    .col-actions {
      width: 120px;
    }
    .copy-cell {
      max-width: 100%;
      cursor: pointer;
    }
    .copy-text {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.45;
    }
    .empty {
      padding: 28px 16px;
      text-align: center;
      color: var(--text-soft);
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(3, 7, 15, 0.72);
      backdrop-filter: blur(10px);
    }
    .modal-backdrop[hidden] {
      display: none;
    }
    .modal {
      width: min(980px, 100%);
      max-height: calc(100vh - 40px);
      overflow: auto;
      padding: 22px;
      border-radius: 28px;
      border: 1px solid var(--line-strong);
      background: rgba(6, 14, 27, 0.97);
      box-shadow: var(--shadow);
    }
    .modal-top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
      margin-bottom: 18px;
    }
    .detail-grid {
      display: grid;
      gap: 16px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .meta-card,
    .detail-card {
      padding: 16px;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.04);
    }
    .meta-card strong,
    .detail-card strong {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      color: var(--text-soft);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .meta-card span {
      display: block;
      word-break: break-word;
    }
    .body-box,
    .html-box,
    .raw-box,
    .code-box {
      margin: 0;
      padding: 16px;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.07);
      background: rgba(4, 9, 18, 0.88);
      color: #dce7f8;
      word-break: break-word;
      overflow: auto;
    }
    .body-box,
    .raw-box,
    .code-box {
      white-space: pre-wrap;
      font-family: "JetBrains Mono", "Fira Code", monospace;
    }
    .html-box {
      padding: 0;
      background: #ffffff;
      color: #111827;
      white-space: normal;
      font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .mail-html-frame {
      display: block;
      width: 100%;
      min-height: 420px;
      border: 0;
      border-radius: 16px;
      background: #ffffff;
    }
    .attachment-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .attachment-row:last-child {
      border-bottom: 0;
    }
    .attachment-name {
      flex: 1;
      min-width: 0;
      word-break: break-all;
    }
    .attachment-meta {
      color: var(--text-soft);
      white-space: nowrap;
    }
    .attachment-dl {
      color: var(--accent);
      text-decoration: none;
      white-space: nowrap;
    }
    .attachment-dl:hover {
      text-decoration: underline;
    }
    .header-table {
      width: 100%;
      min-width: 0;
    }
    .header-table td {
      padding: 10px 12px;
      font-size: 13px;
    }
    .header-table td:first-child {
      width: 180px;
      color: var(--text-soft);
    }
    .doc-grid {
      display: grid;
      gap: 16px;
    }
    .doc-card {
      padding: 20px;
      border-radius: 24px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.04);
    }
    .doc-card h3 {
      margin-bottom: 10px;
      font-size: 22px;
    }
    .doc-card p,
    .doc-card li,
    .doc-card .small {
      color: var(--text-soft);
    }
    .doc-list {
      margin: 10px 0 0;
      padding-left: 18px;
    }
    .top-links {
      margin-top: 16px;
    }
    @keyframes drift {
      0%, 100% {
        transform: translate3d(0, 0, 0) scale(1);
      }
      50% {
        transform: translate3d(0, -12px, 0) scale(1.04);
      }
    }
    @media (max-width: 900px) {
      .hero,
      .meta-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 760px) {
      .wrap {
        padding: 18px 14px 28px;
      }
      .hero,
      .section-panel,
      .modal {
        padding: 18px;
        border-radius: 22px;
      }
      .section-head,
      .modal-top {
        flex-direction: column;
      }
      .field,
      .field.wide {
        grid-column: span 12;
      }
      h1 {
        font-size: 38px;
      }
      .modal-backdrop {
        padding: 12px;
      }
    }
'''

CONSOLE_PAGE_SCRIPT = r'''
    (function () {
      const STORAGE_TOKEN_KEY = "mail_worker_api_token";
      const STORAGE_MANUAL_CLEANUP_MINUTES_KEY = "mail_worker_manual_cleanup_minutes";
      const STORAGE_AUTO_CLEANUP_MINUTES_KEY = "mail_worker_auto_cleanup_minutes";
      const STORAGE_AUTO_REFRESH_SECONDS_KEY = "mail_worker_auto_refresh_seconds";
      const tokenInput = document.getElementById("tokenInput");
      const saveTokenBtn = document.getElementById("saveTokenBtn");
      const verifyTokenBtn = document.getElementById("verifyTokenBtn");
      const clearTokenBtn = document.getElementById("clearTokenBtn");
      const rcptToInput = document.getElementById("rcptToInput");
      const afterInput = document.getElementById("afterInput");
      const beforeInput = document.getElementById("beforeInput");
      const pageSizeSelect = document.getElementById("pageSizeSelect");
      const manualCleanupMinutesInput = document.getElementById("manualCleanupMinutesInput");
      const autoCleanupMinutesInput = document.getElementById("autoCleanupMinutesInput");
      const autoRefreshSecondsInput = document.getElementById("autoRefreshSecondsInput");
      const searchBtn = document.getElementById("searchBtn");
      const cleanupBtn = document.getElementById("cleanupBtn");
      const toggleAutoCleanupBtn = document.getElementById("toggleAutoCleanupBtn");
      const toggleAutoRefreshBtn = document.getElementById("toggleAutoRefreshBtn");
      const autoRefreshStatus = document.getElementById("autoRefreshStatus");
      const autoCleanupStatus = document.getElementById("autoCleanupStatus");
      const resetFiltersBtn = document.getElementById("resetFiltersBtn");
      const prevPageBtn = document.getElementById("prevPageBtn");
      const nextPageBtn = document.getElementById("nextPageBtn");
      const paginationInfo = document.getElementById("paginationInfo");
      const authStatus = document.getElementById("authStatus");
      const actionStatus = document.getElementById("actionStatus");
      const mailTableBody = document.getElementById("mailTableBody");
      const detailModal = document.getElementById("detailModal");
      const detailTitle = document.getElementById("detailTitle");
      const detailMeta = document.getElementById("detailMeta");
      const detailBody = document.getElementById("detailBody");
      const detailHeaders = document.getElementById("detailHeaders");
      const detailAttachments = document.getElementById("detailAttachments");
      const detailRaw = document.getElementById("detailRaw");
      const closeDetailBtn = document.getElementById("closeDetailBtn");
      const closeDetailBtn2 = document.getElementById("closeDetailBtn2");
      const state = { page: 1, pageSize: 20, total: 0, totalPages: 0, lastItems: [], autoRefreshTimer: 0, autoRefreshCountdownTimer: 0, autoRefreshRemainingSeconds: 0, autoCleanupCountdownTimer: 0, autoCleanupRemainingSeconds: 0, isAutoRefreshOn: true, isAutoCleanupOn: false, isLoadingMails: false, isCleaningUp: false, autoCleanupConfiguredMinutes: 10, autoCleanupLastRunAt: "", autoCleanupLastDeletedCount: 0 };

      function setStatus(target, message, kind) {
        target.textContent = message;
        target.dataset.kind = kind || "info";
      }

      function setAuthStatus(message, kind) {
        setStatus(authStatus, message, kind);
      }

      function setActionStatus(message, kind) {
        setStatus(actionStatus, message, kind);
      }

      function getAutoRefreshSeconds() {
        const seconds = parseInt(autoRefreshSecondsInput.value || "0", 10) || 0;
        return seconds >= 1 ? seconds : 3;
      }

      function updateAutoRefreshButton() {
        toggleAutoRefreshBtn.textContent = state.isAutoRefreshOn ? "停止自动查询" : "开启自动查询";
      }

      function updateAutoCleanupButton() {
        toggleAutoCleanupBtn.textContent = state.isAutoCleanupOn ? "停止系统自动清理" : "开启系统自动清理";
      }

      function updateAutoRefreshStatus() {
        if (!state.isAutoRefreshOn) {
          autoRefreshStatus.textContent = "自动查询已停止";
          return;
        }
        autoRefreshStatus.textContent = "自动查询：" + state.autoRefreshRemainingSeconds + " 秒后刷新";
      }

      function updateAutoCleanupStatus() {
        if (!state.isAutoCleanupOn) {
          autoCleanupStatus.textContent = "自动清理：已停止";
          return;
        }
        autoCleanupStatus.textContent = "自动清理：每 " + state.autoCleanupConfiguredMinutes + " 分钟执行一次，约 " + state.autoCleanupRemainingSeconds + " 秒后执行，清理 10 分钟前的邮件";
      }

      function stopAutoRefreshCountdown() {
        if (!state.autoRefreshCountdownTimer) return;
        clearInterval(state.autoRefreshCountdownTimer);
        state.autoRefreshCountdownTimer = 0;
      }

      function stopAutoCleanupCountdown() {
        if (!state.autoCleanupCountdownTimer) return;
        clearInterval(state.autoCleanupCountdownTimer);
        state.autoCleanupCountdownTimer = 0;
      }

      function stopAutoRefresh() {
        if (state.autoRefreshTimer) {
          clearInterval(state.autoRefreshTimer);
          state.autoRefreshTimer = 0;
        }
        stopAutoRefreshCountdown();
      }

      function stopAutoCleanup() {
        stopAutoCleanupCountdown();
      }

      function getManualCleanupMinutes() {
        const minutes = parseInt(manualCleanupMinutesInput.value || "0", 10) || 0;
        return minutes >= 1 ? minutes : 10;
      }

      function getAutoCleanupMinutes() {
        const minutes = parseInt(autoCleanupMinutesInput.value || "0", 10) || 0;
        return minutes >= 1 ? minutes : 10;
      }

      function saveManualCleanupMinutesInput() {
        const minutes = parseInt(manualCleanupMinutesInput.value || "0", 10) || 0;
        if (minutes >= 1) saveValue(STORAGE_MANUAL_CLEANUP_MINUTES_KEY, String(minutes));
      }

      function saveAutoCleanupMinutesInput() {
        const minutes = parseInt(autoCleanupMinutesInput.value || "0", 10) || 0;
        if (minutes >= 1) saveValue(STORAGE_AUTO_CLEANUP_MINUTES_KEY, String(minutes));
      }

      function resetAutoRefreshCountdown() {
        state.autoRefreshRemainingSeconds = getAutoRefreshSeconds();
        updateAutoRefreshStatus();
      }

      function resetAutoCleanupCountdown() {
        state.autoCleanupRemainingSeconds = state.autoCleanupConfiguredMinutes * 60;
        updateAutoCleanupStatus();
      }

      function startAutoRefreshCountdown() {
        stopAutoRefreshCountdown();
        resetAutoRefreshCountdown();
        state.autoRefreshCountdownTimer = window.setInterval(function () {
          if (!state.isAutoRefreshOn || document.hidden) return;
          if (state.autoRefreshRemainingSeconds > 1) {
            state.autoRefreshRemainingSeconds -= 1;
          } else {
            state.autoRefreshRemainingSeconds = getAutoRefreshSeconds();
          }
          updateAutoRefreshStatus();
        }, 1000);
      }

      function startAutoCleanupCountdown() {
        stopAutoCleanupCountdown();
        resetAutoCleanupCountdown();
        state.autoCleanupCountdownTimer = window.setInterval(function () {
          if (!state.isAutoCleanupOn || document.hidden) return;
          if (state.autoCleanupRemainingSeconds > 1) {
            state.autoCleanupRemainingSeconds -= 1;
          } else {
            state.autoCleanupRemainingSeconds = state.autoCleanupConfiguredMinutes * 60;
          }
          updateAutoCleanupStatus();
        }, 1000);
      }

      function startAutoRefresh() {
        stopAutoRefresh();
        const seconds = getAutoRefreshSeconds();
        resetAutoRefreshCountdown();
        startAutoRefreshCountdown();
        state.autoRefreshTimer = window.setInterval(function () {
          if (!state.isAutoRefreshOn || document.hidden || state.isLoadingMails) return;
          loadMails(state.page, { loadingText: "收件中", isAutoRefresh: true });
          state.autoRefreshRemainingSeconds = seconds;
          updateAutoRefreshStatus();
        }, seconds * 1000);
      }

      function startAutoCleanup() {
        stopAutoCleanup();
        resetAutoCleanupCountdown();
        startAutoCleanupCountdown();
      }

      function syncAutoRefresh() {
        updateAutoRefreshButton();
        if (!state.isAutoRefreshOn) {
          stopAutoRefresh();
          return updateAutoRefreshStatus();
        }
        startAutoRefresh();
      }

      function syncAutoCleanup() {
        updateAutoCleanupButton();
        if (!state.isAutoCleanupOn) {
          stopAutoCleanup();
          return updateAutoCleanupStatus();
        }
        startAutoCleanup();
      }

      async function loadAutoCleanupConfig() {
        const data = await fetchJson("/api/admin/auto-cleanup", { method: "GET" });
        state.isAutoCleanupOn = !!data.enabled;
        state.autoCleanupConfiguredMinutes = Number(data.intervalMinutes || 10);
        state.autoCleanupLastRunAt = String(data.lastRunAt || "");
        state.autoCleanupLastDeletedCount = Number(data.lastDeletedCount || 0);
        autoCleanupMinutesInput.value = String(state.autoCleanupConfiguredMinutes);
        syncAutoCleanup();
      }

      async function saveAutoCleanupConfig(enabled) {
        const minutes = getAutoCleanupMinutes();
        autoCleanupMinutesInput.value = String(minutes);
        saveAutoCleanupMinutesInput();
        const data = await fetchJson("/api/admin/auto-cleanup", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !!enabled, intervalMinutes: minutes })
        });
        state.isAutoCleanupOn = !!data.enabled;
        state.autoCleanupConfiguredMinutes = Number(data.intervalMinutes || minutes);
        state.autoCleanupLastRunAt = String(data.lastRunAt || "");
        state.autoCleanupLastDeletedCount = Number(data.lastDeletedCount || 0);
        syncAutoCleanup();
      }

      function getSavedToken() {
        try { return localStorage.getItem(STORAGE_TOKEN_KEY) || ""; }
        catch { return ""; }
      }

      function getSavedValue(key, fallback) {
        try { return localStorage.getItem(key) || fallback; }
        catch { return fallback; }
      }

      function saveValue(key, value) {
        try { localStorage.setItem(key, String(value)); }
        catch {}
      }

      function saveToken(token) {
        localStorage.setItem(STORAGE_TOKEN_KEY, token);
      }

      function clearToken() {
        localStorage.removeItem(STORAGE_TOKEN_KEY);
      }

      function getToken() {
        return tokenInput.value.trim();
      }

      function requireTokenOnClient() {
        const token = getToken();
        if (!token) {
          setAuthStatus("请先输入并保存 API_TOKEN。", "error");
          return "";
        }
        return token;
      }

      function buildAuthHeaders(extraHeaders) {
        const token = requireTokenOnClient();
        if (!token) return null;
        const headers = new Headers(extraHeaders || {});
        headers.set("Authorization", "Bearer " + token);
        return headers;
      }

      async function fetchJson(path, init) {
        const headers = buildAuthHeaders(init && init.headers ? init.headers : {});
        if (!headers) throw new Error("缺少 API_TOKEN");
        const response = await fetch(path, { ...init, headers });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; }
        catch { data = { rawText: text }; }
        if (!response.ok) {
          const message = data && data.error ? data.error : ("请求失败，状态码 " + response.status);
          throw new Error(message);
        }
        return data;
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function formatDateTimeDisplay(value) {
        if (!value) return "";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
      }

      function toIsoFromLocalInput(value) {
        if (!value) return "";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : date.toISOString();
      }

      function sanitizeHtml(value) {
        const dirty = String(value || "");
        if (window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
          return window.DOMPurify.sanitize(dirty, {
            USE_PROFILES: { html: true },
            FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "meta"],
            FORBID_ATTR: ["srcset"],
            ALLOW_DATA_ATTR: false
          });
        }
        const doc = new DOMParser().parseFromString(dirty, "text/html");
        doc.querySelectorAll("script,style,iframe,object,embed,link,meta,base").forEach(function (node) {
          node.remove();
        });
        doc.querySelectorAll("*").forEach(function (node) {
          Array.from(node.attributes).forEach(function (attr) {
            const name = attr.name.toLowerCase();
            const value = String(attr.value || "").trim().toLowerCase();
            if (name.startsWith("on")) node.removeAttribute(attr.name);
            if (["src", "href", "xlink:href"].includes(name) && value.startsWith("javascript:")) {
              node.removeAttribute(attr.name);
            }
          });
        });
        return doc.body ? doc.body.innerHTML : dirty;
      }

      function buildHtmlPreviewDocument(value) {
        const cleanHtml = sanitizeHtml(value);
        return [
          '<!DOCTYPE html><html><head><meta charset="UTF-8">',
          '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
          '<style>html,body{margin:0;padding:0;background:#fff;color:#111827;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;}body{padding:16px;line-height:1.6;}img{max-width:100%;height:auto;}table{max-width:100%;border-collapse:collapse;}pre{white-space:pre-wrap;word-break:break-word;}a{color:#2563eb;}</style>',
          '</head><body>',
          cleanHtml,
          '</body></html>'
        ].join("");
      }

      function renderHtmlBody(value) {
        detailBody.innerHTML = '<iframe class="mail-html-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>';
        const frame = detailBody.querySelector("iframe");
        if (!(frame instanceof HTMLIFrameElement)) return;
        frame.srcdoc = buildHtmlPreviewDocument(value);
      }

      function htmlToText(value) {
        const doc = new DOMParser().parseFromString(String(value || ""), "text/html");
        return doc.body ? (doc.body.textContent || "") : String(value || "");
      }

      function cleanupBodyText(value) {
        return String(value || "").replace(/\n{3,}/g, "\n\n").trim();
      }

      function renderMetaCard(label, value) {
        return [
          '<div class="meta-card"><strong>',
          escapeHtml(label),
          '</strong><span>',
          escapeHtml(value || "-"),
          '</span></div>'
        ].join("");
      }

      function renderCopyCell(value, className) {
        const text = String(value || "");
        return [
          '<td class="copy-cell ',
          className,
          '" title="点击复制完整内容" data-copy="',
          escapeHtml(text),
          '"><span class="copy-text">',
          escapeHtml(text || "-"),
          '</span></td>'
        ].join("");
      }

      function renderHeaderTable(headers) {
        const entries = Object.entries(headers || {});
        if (entries.length === 0) return '<div class="small">暂无头信息</div>';
        return [
          '<table class="header-table"><tbody>',
          entries.map(function (entry) {
            return '<tr><td>' + escapeHtml(entry[0]) + '</td><td>' + escapeHtml(entry[1]) + '</td></tr>';
          }).join(""),
          '</tbody></table>'
        ].join("");
      }

      function openDetailModal() {
        detailModal.hidden = false;
        document.body.style.overflow = "hidden";
      }

      function closeDetailModal() {
        detailModal.hidden = true;
        document.body.style.overflow = "";
      }

      function renderTable(items) {
        if (!Array.isArray(items) || items.length === 0) {
          mailTableBody.innerHTML = '<tr><td colspan="6" class="empty">没有符合条件的邮件</td></tr>';
          return;
        }
        const rows = items.map(function (item) {
          return [
            '<tr>',
            '<td class="col-time">', escapeHtml(formatDateTimeDisplay(item.receivedAt)), '</td>',
            '<td class="col-to">', escapeHtml(item.to || ""), '</td>',
            renderCopyCell(item.from, 'col-from'),
            renderCopyCell(item.subject, 'col-subject'),
            renderCopyCell(item.messageId, 'col-message-id'),
            '<td class="col-actions"><button class="secondary detail-btn" type="button" data-id="', escapeHtml(item.id || ""), '">查看详情</button></td>',
            '</tr>'
          ].join("");
        }).join("");
        mailTableBody.innerHTML = rows;
      }

      function updatePaginationInfo() {
        paginationInfo.textContent = "第 " + state.page + " / " + (state.totalPages || 1) + " 页，共 " + state.total + " 封";
        prevPageBtn.disabled = state.page <= 1;
        nextPageBtn.disabled = state.totalPages === 0 || state.page >= state.totalPages;
      }

      function getCurrentQueryParams(pageOverride) {
        const params = new URLSearchParams();
        const rcptTo = rcptToInput.value.trim();
        const after = toIsoFromLocalInput(afterInput.value);
        const before = toIsoFromLocalInput(beforeInput.value);
        const page = pageOverride || state.page || 1;
        const pageSize = parseInt(pageSizeSelect.value || "20", 10) || 20;
        if (rcptTo) params.set("rcptTo", rcptTo);
        if (after) params.set("after", after);
        if (before) params.set("before", before);
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
        return { params, page, pageSize };
      }

      function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
      }

      function renderAttachmentList(items) {
        if (!Array.isArray(items) || items.length === 0) {
          detailAttachments.innerHTML = '<div class="small">无附件</div>';
          return;
        }
        // 每个附件渲染为一行下载链接。
        detailAttachments.innerHTML = items.map(function (a) {
          return [
            '<div class="attachment-row">',
            '<span class="attachment-name">' + escapeHtml(a.filename) + '</span>',
            '<span class="attachment-meta">' + escapeHtml(a.contentType) + ' · ' + formatFileSize(a.sizeBytes) + '</span>',
            '<a class="attachment-dl" href="' + escapeHtml(a.downloadUrl) + '" download="' + escapeHtml(a.filename) + '">下载</a>',
            '</div>'
          ].join("");
        }).join("");
      }

      function renderMailDetail(data) {
        detailTitle.textContent = data.subject || "邮件详情";
        detailMeta.innerHTML = [
          renderMetaCard("主题", data.subject),
          renderMetaCard("发件人", data.from),
          renderMetaCard("收件人", data.to),
          renderMetaCard("接收时间", formatDateTimeDisplay(data.receivedAt || data.date)),
          renderMetaCard("Message-ID", data.messageId),
          renderMetaCard("日期头", data.date)
        ].join("");
        if (data.htmlBody) {
          renderHtmlBody(data.htmlBody);
        } else {
          detailBody.textContent = cleanupBodyText(data.textBody || htmlToText(data.raw)) || "没有提取到可读正文。";
        }
        detailHeaders.innerHTML = renderHeaderTable(data.headers);
        detailRaw.textContent = data.raw || "暂无原始内容";
      }

      async function loadMails(pageOverride, options) {
        const loadingText = options && options.loadingText ? String(options.loadingText) : "查询中...";
        const isAutoRefresh = !!(options && options.isAutoRefresh);
        if (state.isLoadingMails) return;
        state.isLoadingMails = true;
        try {
          const current = getCurrentQueryParams(pageOverride);
          state.page = current.page;
          state.pageSize = current.pageSize;
          if (!isAutoRefresh) setActionStatus(loadingText, "info");
          const data = await fetchJson("/api/mails?" + current.params.toString(), { method: "GET" });
          state.total = Number(data.total || 0);
          state.totalPages = Number(data.totalPages || 0);
          state.page = Number(data.page || current.page);
          state.pageSize = Number(data.pageSize || current.pageSize);
          state.lastItems = Array.isArray(data.items) ? data.items : [];
          renderTable(state.lastItems);
          updatePaginationInfo();
          if (!isAutoRefresh) setActionStatus("查询成功。", "success");
        } catch (error) {
          renderTable([]);
          state.total = 0;
          state.totalPages = 0;
          updatePaginationInfo();
          setActionStatus("查询失败: " + (error && error.message ? error.message : String(error)), "error");
        } finally {
          state.isLoadingMails = false;
        }
      }

      async function loadMailDetail(id) {
        try {
          detailTitle.textContent = "邮件详情加载中";
          detailMeta.innerHTML = "";
          detailBody.textContent = "正在整理邮件正文...";
          detailHeaders.innerHTML = "";
          detailAttachments.innerHTML = '<div class="small">加载中...</div>';
          detailRaw.textContent = "";
          openDetailModal();
          // 并行请求邮件详情与附件列表，减少等待时间。
          const [data, attData] = await Promise.all([
            fetchJson("/api/mails/" + encodeURIComponent(id), { method: "GET" }),
            fetchJson("/api/mails/" + encodeURIComponent(id) + "/attachments", { method: "GET" })
          ]);
          renderMailDetail(data);
          renderAttachmentList(attData.items || []);
        } catch (error) {
          detailTitle.textContent = "邮件详情";
          detailBody.textContent = "详情加载失败: " + (error && error.message ? error.message : String(error));
        }
      }

      async function verifyToken() {
        try {
          setAuthStatus("正在验证 Token...", "info");
          await fetchJson("/api/auth/verify", { method: "GET" });
          setAuthStatus("Token 验证成功。", "success");
        } catch (error) {
          setAuthStatus("Token 验证失败: " + (error && error.message ? error.message : String(error)), "error");
        }
      }

      async function cleanupHistoryMails() {
        const token = requireTokenOnClient();
        if (!token) return;
        const minutes = getManualCleanupMinutes();
        if (minutes < 1) {
          setActionStatus("请输入大于 0 的手动清理分钟数。", "error");
          return;
        }
        const cutoff = new Date(Date.now() - minutes * 60 * 1000);
        const confirmed = confirm("确定清理 " + minutes + " 分钟前的所有历史邮件吗？\n清理阈值: " + cutoff.toLocaleString());
        if (!confirmed) return;
        state.isCleaningUp = true;
        try {
          setActionStatus("正在手动清理 " + minutes + " 分钟前的历史邮件...", "info");
          const data = await fetchJson("/api/admin/cleanup-history", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ before: cutoff.toISOString() })
          });
          setActionStatus("手动清理完成。删除数量: " + String(data.deletedCount || 0) + "，阈值: " + String(data.before || ""), "success");
          await loadMails(1);
        } catch (error) {
          setActionStatus("手动清理失败: " + (error && error.message ? error.message : String(error)), "error");
        } finally {
          state.isCleaningUp = false;
        }
      }

      function resetFilters() {
        rcptToInput.value = "";
        afterInput.value = "";
        beforeInput.value = "";
        pageSizeSelect.value = "20";
        manualCleanupMinutesInput.value = "10";
        autoRefreshSecondsInput.value = "3";
        saveValue(STORAGE_MANUAL_CLEANUP_MINUTES_KEY, "10");
        saveValue(STORAGE_AUTO_REFRESH_SECONDS_KEY, "3");
        syncAutoRefresh();
      }

      async function copyCellValue(value) {
        if (!value) return;
        await navigator.clipboard.writeText(value);
        setActionStatus("已复制完整内容。", "success");
      }

      saveTokenBtn.addEventListener("click", function () {
        const token = getToken();
        if (!token) return setAuthStatus("请输入 API_TOKEN 后再保存。", "error");
        saveToken(token);
        setAuthStatus("API_TOKEN 已保存到本地浏览器。", "success");
      });
      verifyTokenBtn.addEventListener("click", function () { verifyToken(); });
      clearTokenBtn.addEventListener("click", function () {
        tokenInput.value = "";
        clearToken();
        setAuthStatus("本地 API_TOKEN 已清空。", "success");
      });
      searchBtn.addEventListener("click", function () {
        loadMails(1);
      });
      cleanupBtn.addEventListener("click", function () { cleanupHistoryMails(); });
      manualCleanupMinutesInput.addEventListener("input", saveManualCleanupMinutesInput);
      manualCleanupMinutesInput.addEventListener("change", function () {
        manualCleanupMinutesInput.value = String(getManualCleanupMinutes());
        saveManualCleanupMinutesInput();
      });
      autoCleanupMinutesInput.addEventListener("input", saveAutoCleanupMinutesInput);
      autoCleanupMinutesInput.addEventListener("change", function () {
        autoCleanupMinutesInput.value = String(getAutoCleanupMinutes());
        saveAutoCleanupMinutesInput();
      });
      toggleAutoCleanupBtn.addEventListener("click", async function () {
        try {
          await saveAutoCleanupConfig(!state.isAutoCleanupOn);
          setActionStatus(state.isAutoCleanupOn ? "系统自动清理已开启。" : "系统自动清理已停止。", "info");
        } catch (error) {
          setActionStatus("更新系统自动清理失败: " + (error && error.message ? error.message : String(error)), "error");
        }
      });
      toggleAutoRefreshBtn.addEventListener("click", function () {
        state.isAutoRefreshOn = !state.isAutoRefreshOn;
        syncAutoRefresh();
        setActionStatus(state.isAutoRefreshOn ? "自动查询已开启。" : "自动查询已停止。", "info");
      });
      autoRefreshSecondsInput.addEventListener("change", function () {
        const seconds = getAutoRefreshSeconds();
        autoRefreshSecondsInput.value = String(seconds);
        saveValue(STORAGE_AUTO_REFRESH_SECONDS_KEY, autoRefreshSecondsInput.value);
        syncAutoRefresh();
        setActionStatus("自动查询间隔已更新为 " + seconds + " 秒。", "info");
      });
      resetFiltersBtn.addEventListener("click", function () {
        resetFilters();
        setActionStatus("筛选条件已重置。", "info");
      });
      prevPageBtn.addEventListener("click", function () {
        if (state.page > 1) loadMails(state.page - 1);
      });
      nextPageBtn.addEventListener("click", function () {
        if (state.totalPages > 0 && state.page < state.totalPages) loadMails(state.page + 1);
      });
      mailTableBody.addEventListener("click", function (event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const button = target.closest(".detail-btn");
        if (button instanceof HTMLElement) {
          const id = button.getAttribute("data-id");
          if (id) loadMailDetail(id);
          return;
        }
        const cell = target.closest(".copy-cell");
        if (!(cell instanceof HTMLElement)) return;
        const value = cell.getAttribute("data-copy") || "";
        copyCellValue(value).catch(function () {
          setActionStatus("复制失败，请手动选择内容。", "error");
        });
      });
      closeDetailBtn.addEventListener("click", closeDetailModal);
      closeDetailBtn2.addEventListener("click", closeDetailModal);
      detailModal.addEventListener("click", function (event) {
        if (event.target === detailModal) closeDetailModal();
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !detailModal.hidden) closeDetailModal();
      });
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
          stopAutoRefresh();
          return stopAutoCleanup();
        }
        if (state.isAutoRefreshOn) {
          syncAutoRefresh();
          loadMails(state.page, {
            isAutoRefresh: true,
            loadingText: "收件中"
          });
        }
        if (state.isAutoCleanupOn) startAutoCleanupCountdown();
      });
      autoRefreshSecondsInput.value = getSavedValue(STORAGE_AUTO_REFRESH_SECONDS_KEY, "3");
      manualCleanupMinutesInput.value = getSavedValue(STORAGE_MANUAL_CLEANUP_MINUTES_KEY, "10");
      autoCleanupMinutesInput.value = getSavedValue(STORAGE_AUTO_CLEANUP_MINUTES_KEY, "10");
      autoRefreshSecondsInput.value = String(getAutoRefreshSeconds());
      manualCleanupMinutesInput.value = String(getManualCleanupMinutes());
      autoCleanupMinutesInput.value = String(getAutoCleanupMinutes());
      syncAutoRefresh();
      const savedToken = getSavedToken();
      if (savedToken) {
        tokenInput.value = savedToken;
        setAuthStatus("已从本地读取 API_TOKEN，可以直接查询。", "success");
        loadAutoCleanupConfig().catch(function (error) {
          setActionStatus("读取系统自动清理配置失败: " + (error && error.message ? error.message : String(error)), "error");
        });
      }
    })();
'''

CONSOLE_PAGE_TEMPLATE = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email Workers Console</title>
  <style>__STYLE__</style>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.3.3/dist/purify.min.js"></script>
</head>
<body>
  <div class="page-shell">
    <div class="wrap">
      <section class="hero panel">
        <div class="hero-copy">
          <span class="eyebrow">FASTAPI MAIL CONSOLE</span>
          <h1>邮件收件箱控制台</h1>
          <div class="hero-actions">
            <a class="nav-link primary" href="/docs">API 文档</a>
            <a class="nav-link secondary" href="/openapi">Swagger</a>
          </div>
        </div>
      </section>

      <div class="layout-grid">
        <section class="panel section-panel">
          <div class="section-head">
            <div>
              <h2>身份验证</h2>
              <div class="section-note">先完成本地 Token 配置，再使用查询与清理操作。</div>
            </div>
            <div class="section-tag">Local Storage</div>
          </div>
          <div class="row">
            <div class="field wide">
              <label for="tokenInput">API_TOKEN</label>
              <input id="tokenInput" type="password" placeholder="请输入 API_TOKEN" autocomplete="off" />
            </div>
          </div>
          <div class="toolbar">
            <button id="saveTokenBtn" class="primary" type="button">保存 Token</button>
            <button id="verifyTokenBtn" class="secondary" type="button">验证 Token</button>
            <button id="clearTokenBtn" class="secondary" type="button">清空 Token</button>
          </div>
          <div class="status-shell">
            <div id="authStatus" class="status muted" data-kind="info">请先输入并保存 API_TOKEN，再进行查询。</div>
          </div>
        </section>

        <section class="panel section-panel">
          <div class="section-head">
            <div>
              <h2>筛选与操作</h2>
              <div class="section-note">支持按收件邮箱、时间区间与分页参数查询。</div>
            </div>
            <div class="meta-pills">
              <span class="pill">PostgreSQL</span>
              <span class="pill">Paginated</span>
            </div>
          </div>
          <div class="row">
            <div class="field wide">
              <label for="rcptToInput">收件邮箱</label>
              <input id="rcptToInput" type="text" placeholder="留空表示查看全部，例如 yuyan@anyu.297589.best" />
            </div>
            <div class="field">
              <label for="afterInput">开始时间</label>
              <input id="afterInput" type="datetime-local" />
            </div>
            <div class="field">
              <label for="beforeInput">结束时间</label>
              <input id="beforeInput" type="datetime-local" />
            </div>
            <div class="field">
              <label for="pageSizeSelect">每页条数</label>
              <select id="pageSizeSelect">
                <option value="10">10</option>
                <option value="20" selected>20</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </div>
            <div class="field">
              <label for="manualCleanupMinutesInput">手动清理阈值(分钟)</label>
              <div class="section-note">点击手动清理按钮时，删除该分钟数之前的历史邮件。</div>
              <input id="manualCleanupMinutesInput" type="number" min="1" value="10" />
            </div>
            <div class="field">
              <label for="autoCleanupMinutesInput">系统自动清理间隔(分钟)</label>
              <div class="section-note">后端按这个间隔执行自动清理，前端只负责配置开关和间隔。</div>
              <input id="autoCleanupMinutesInput" type="number" min="1" value="10" />
            </div>
            <div class="field">
              <label for="autoRefreshSecondsInput">自动查询(秒)</label>
              <input id="autoRefreshSecondsInput" type="number" min="1" value="3" />
            </div>
          </div>
          <div class="toolbar">
            <button id="searchBtn" class="primary" type="button">查询邮件</button>
            <button id="toggleAutoRefreshBtn" class="secondary" type="button">停止自动查询</button>
            <button id="toggleAutoCleanupBtn" class="secondary" type="button">开启系统自动清理</button>
            <button id="cleanupBtn" class="danger" type="button">手动清理历史邮件</button>
            <button id="resetFiltersBtn" class="secondary" type="button">重置筛选</button>
          </div>
          <div class="status-shell">
            <div id="actionStatus" class="status muted" data-kind="info">查询、重置、清理与复制提示会显示在这里。</div>
          </div>
          <div class="status-shell">
            <div id="autoRefreshStatus" class="status muted" data-kind="info">自动查询：3 秒后刷新</div>
          </div>
          <div class="status-shell">
            <div id="autoCleanupStatus" class="status muted" data-kind="info">自动清理：已停止</div>
          </div>
          <div style="height: 16px;"></div>
          <div class="pagination">
            <button id="prevPageBtn" class="secondary" type="button">上一页</button>
            <button id="nextPageBtn" class="secondary" type="button">下一页</button>
            <span id="paginationInfo" class="pill">等待查询</span>
          </div>
        </section>

        <section class="panel section-panel">
          <div class="section-head">
            <div>
              <h2>邮件列表</h2>
              <div class="section-note">点击“查看详情”后使用弹窗展示整理后的邮件内容。</div>
            </div>
            <div class="section-tag">Inbox View</div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="col-time">收到时间</th>
                  <th class="col-to">收件邮箱</th>
                  <th class="col-from">发件邮箱</th>
                  <th class="col-subject">主题</th>
                  <th class="col-message-id">Message-ID</th>
                  <th class="col-actions">操作</th>
                </tr>
              </thead>
              <tbody id="mailTableBody">
                <tr><td colspan="6" class="empty">暂无数据</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  </div>

  <div id="detailModal" class="modal-backdrop" hidden>
    <div class="modal">
      <div class="modal-top">
        <div>
          <h2 id="detailTitle">邮件详情</h2>
          <div class="section-note">优先展示可读正文，HTML 正文会经过 DOMPurify 清洗后在隔离 iframe 中渲染。</div>
        </div>
        <button id="closeDetailBtn" class="secondary" type="button">关闭</button>
      </div>
      <div class="detail-grid">
        <div id="detailMeta" class="meta-grid"></div>
        <div class="detail-card">
          <strong>正文</strong>
          <div id="detailBody" class="html-box body-box">暂无详情</div>
        </div>
        <div class="detail-card">
          <strong>附件</strong>
          <div id="detailAttachments"><div class="small">无附件</div></div>
        </div>
        <div class="detail-card">
          <strong>邮件头</strong>
          <div id="detailHeaders"></div>
        </div>
        <div class="detail-card">
          <strong>原始内容</strong>
          <pre id="detailRaw" class="raw-box"></pre>
        </div>
        <div class="toolbar">
          <button id="closeDetailBtn2" class="secondary" type="button">关闭弹窗</button>
        </div>
      </div>
    </div>
  </div>

  <script>__SCRIPT__</script>
</body>
</html>'''

DOCS_PAGE_TEMPLATE = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email Workers Docs</title>
  <style>__STYLE__</style>
</head>
<body>
  <div class="page-shell">
    <div class="wrap">
      <section class="hero panel">
        <div class="hero-copy">
          <span class="eyebrow">API DOCUMENTATION</span>
          <h1>接口文档</h1>
          <p class="hero-text">控制台现在由 FastAPI 提供，邮件存储位于 PostgreSQL，邮件写入入口由 Cloudflare Worker 调用内部接口。</p>
          <div class="top-links">
            <a class="nav-link primary" href="/">返回首页</a>
            <a class="nav-link secondary" href="/openapi">Swagger</a>
          </div>
        </div>
        <div class="panel-note">
          <strong>文档说明</strong>
          <div class="small">所有接口都需要 <code>Authorization: Bearer API_TOKEN</code>。</div>
        </div>
      </section>

      <div class="doc-grid">
        <section class="doc-card">
          <h3>认证验证</h3>
          <div class="small">GET <code>/api/auth/verify</code></div>
          <p>用于验证当前 Token 是否正确。</p>
          <pre class="code-box">fetch("/api/auth/verify", {
  method: "GET",
  headers: {
    Authorization: "Bearer " + token
  }
});</pre>
        </section>

        <section class="doc-card">
          <h3>邮件列表</h3>
          <div class="small">GET <code>/api/mails</code></div>
          <ul class="doc-list">
            <li><code>rcptTo</code>: 可选，按收件邮箱过滤。</li>
            <li><code>after</code>: 可选，开始时间，ISO 字符串。</li>
            <li><code>before</code>: 可选，结束时间，ISO 字符串。</li>
            <li><code>page</code>: 页码，从 1 开始。</li>
            <li><code>pageSize</code>: 每页条数，最大 100。</li>
          </ul>
          <pre class="code-box">const params = new URLSearchParams({
  rcptTo: "demo@example.com",
  page: "1",
  pageSize: "20"
});

fetch("/api/mails?" + params.toString(), {
  method: "GET",
  headers: {
    Authorization: "Bearer " + token
  }
});</pre>
        </section>

        <section class="doc-card">
          <h3>邮件详情</h3>
          <div class="small">GET <code>/api/mails/{id}</code></div>
          <p>返回单封邮件的基础信息、头信息和原始内容。</p>
          <pre class="code-box">fetch("/api/mails/MAIL_ID", {
  method: "GET",
  headers: {
    Authorization: "Bearer " + token
  }
});</pre>
        </section>

        <section class="doc-card">
          <h3>系统自动清理配置</h3>
          <div class="small">GET / PUT <code>/api/admin/auto-cleanup</code></div>
          <p>用于读取或更新后端自动清理开关与执行间隔。系统默认清理 10 分钟前的邮件。</p>
          <pre class="code-box">fetch("/api/admin/auto-cleanup", {
  method: "PUT",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    enabled: true,
    intervalMinutes: 10
  })
});</pre>
        </section>

        <section class="doc-card">
          <h3>手动历史清理</h3>
          <div class="small">POST <code>/api/admin/cleanup-history</code></div>
          <p>仅在你手动触发时执行清理，也可传入 JSON body 指定 <code>before</code> 时间；不传时默认清理一天前的邮件。</p>
          <pre class="code-box">fetch("/api/admin/cleanup-history", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    before: "2025-01-01T00:00:00.000Z"
  })
});</pre>
        </section>

        <section class="doc-card">
          <h3>内部写入接口</h3>
          <div class="small">POST <code>/internal/emails</code></div>
          <p>仅供 Cloudflare Worker 调用，负责把收到的邮件落到 PostgreSQL。</p>
          <pre class="code-box">fetch("/internal/emails", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(payload)
});</pre>
        </section>

        <section class="doc-card">
          <h3>兼容接口</h3>
          <ul class="doc-list">
            <li><code>GET /api/mail/{email}?after=&before=&page=1&pageSize=20</code></li>
            <li><code>GET /api/mail/{email}/{id}</code></li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</body>
</html>'''


def get_connection() -> psycopg.Connection:
    """创建 PostgreSQL 连接并使用字典行返回结果。"""
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def ensure_settings() -> None:
    """校验服务运行所需的关键环境变量是否已配置。"""
    for name, value in (("DATABASE_URL", DATABASE_URL), ("API_TOKEN", API_TOKEN)):
        if not value:
            raise RuntimeError(f"Missing required environment variable: {name}")


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


def normalize_email_address(address: str) -> str:
    """标准化邮箱地址，统一转为去空格小写形式。"""
    return address.strip().lower()


def is_valid_email_address(address: str) -> bool:
    """判断邮箱地址格式是否有效。"""
    return bool(re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", address))


def truncate_text(value: str, max_length: int) -> str:
    """将超长文本截断到指定长度。"""
    if len(value) <= max_length:
        return value
    return value[:max_length]


def parse_raw_message(raw_text: str) -> Any:
    """将原始邮件文本解析为邮件对象。"""
    return Parser(policy=policy.default).parsestr(raw_text or "")


def decode_part_bytes(value: bytes, charset: str | None) -> str:
    """按候选字符集解码邮件字节内容。"""
    for name in (charset, "utf-8", "gb18030", "latin-1"):
        if not name:
            continue
        try:
            return value.decode(name)
        except Exception:
            continue
    return value.decode("utf-8", errors="replace")


def get_message_part_content(part: Any) -> str:
    """提取并解码单个邮件分片正文。"""
    try:
        content = part.get_content()
    except Exception:
        payload = part.get_payload(decode=True)
        if isinstance(payload, bytes):
            return decode_part_bytes(payload, part.get_content_charset())
        return payload if isinstance(payload, str) else ""
    return content if isinstance(content, str) else str(content or "")


def extract_mail_bodies(raw_text: str) -> dict[str, str]:
    """从原始邮件中提取文本与 HTML 正文。"""
    message = parse_raw_message(raw_text)
    html_body = ""
    text_body = ""
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        content = get_message_part_content(part).strip()
        content_type = (part.get_content_type() or "").lower()
        if content_type == "text/plain" and content and not text_body:
            text_body = content
        if content_type == "text/html" and content and not html_body:
            html_body = content
    return {"textBody": text_body, "htmlBody": html_body}


def _decode_attachment_filename(part: Any) -> str:
    """解码附件文件名，优先取 filename 参数，回退到 name 参数。"""
    filename = part.get_filename() or part.get_param("name") or ""
    return decode_mail_header(filename) or "attachment"


def _safe_attachment_filename(raw_name: str, attachment_id: str) -> str:
    """对附件文件名做路径安全处理，防止目录穿越。"""
    base = os.path.basename(raw_name).strip() or "attachment"
    # 只保留合法字符，其余替换为下划线。
    safe = re.sub(r"[^\w.\-]", "_", base)
    return f"{attachment_id}_{safe}"


def _write_attachment_file(attachment_id: str, raw_name: str, data: bytes) -> str:
    """将附件字节写入磁盘，返回相对于 ATTACHMENTS_DIR 的文件路径。"""
    filename = _safe_attachment_filename(raw_name, attachment_id)
    file_path = os.path.join(ATTACHMENTS_DIR, filename)
    with open(file_path, "wb") as f:
        f.write(data)
    return filename


def extract_and_save_attachments(mail_id: str, raw_text: str) -> list[dict[str, Any]]:
    """提取邮件所有附件，写入磁盘并返回元数据列表。"""
    message = parse_raw_message(raw_text)
    results: list[dict[str, Any]] = []
    for part in message.walk():
        if part.is_multipart():
            continue
        disposition = (part.get_content_disposition() or "").lower()
        if disposition != "attachment":
            continue
        data = part.get_payload(decode=True)
        if not isinstance(data, bytes) or not data:
            continue
        if len(data) > MAX_SINGLE_ATTACHMENT_BYTES:
            continue
        attachment_id = str(uuid4())
        raw_name = _decode_attachment_filename(part)
        filename = _write_attachment_file(attachment_id, raw_name, data)
        results.append({
            "id": attachment_id,
            "mail_id": mail_id,
            "filename": raw_name,
            "content_type": part.get_content_type() or "application/octet-stream",
            "size_bytes": len(data),
            "file_path": filename,
        })
    return results


def insert_attachments(conn: Any, attachments: list[dict[str, Any]]) -> None:
    """批量写入附件元数据到数据库。"""
    if not attachments:
        return
    with conn.cursor() as cur:
        for a in attachments:
            cur.execute(SQL_INSERT_ATTACHMENT, [
                a["id"], a["mail_id"], a["filename"],
                a["content_type"], a["size_bytes"], a["file_path"],
            ])


def decode_mail_header(value: Any) -> str:
    """解码单个邮件头字段。"""
    text = str(value or "")
    if not text:
        return ""
    try:
        return str(make_header(decode_header(text))).strip()
    except Exception:
        return text.strip()


def extract_header_map(message: Any) -> dict[str, str]:
    """提取并解码全部邮件头。"""
    result: dict[str, str] = {}
    for key, value in message.items():
        result[str(key)] = decode_mail_header(value)
    return result


def extract_header_address(message: Any, name: str) -> str:
    """从指定邮件头提取邮箱地址。"""
    _, address = parseaddr(decode_mail_header(message.get(name)))
    return normalize_email_address(address) if address else ""


def extract_message_id(message: Any) -> str:
    """提取 Message-ID，不存在时生成新值。"""
    return decode_mail_header(message.get("Message-ID")) or str(uuid4())


def extract_subject(message: Any) -> str:
    """提取邮件主题。"""
    return decode_mail_header(message.get("Subject")) or "(no subject)"


def extract_date_header(message: Any) -> str:
    """提取邮件日期头。"""
    return decode_mail_header(message.get("Date"))


def parse_positive_integer(value: int | None, fallback: int, minimum: int, maximum: int) -> int:
    """将输入整数约束到指定范围，非法时返回默认值。"""
    if value is None:
        return fallback
    if value < minimum:
        return fallback
    return min(value, maximum)


def parse_datetime_filter(value: str | None, label: str) -> datetime | None:
    """解析 ISO 时间筛选参数，不合法时抛出 400 错误。"""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid '{label}' datetime.") from exc


def isoformat_value(value: Any) -> str:
    """将时间值转换为统一的 UTC ISO 字符串。"""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value or "")


def create_auto_cleanup_state() -> dict[str, Any]:
    """创建自动清理运行状态。"""
    return {
        "enabled": False,
        "intervalMinutes": AUTO_CLEANUP_DEFAULT_INTERVAL_MINUTES,
        "task": None,
        "lastRunAt": "",
        "lastDeletedCount": 0,
    }


def create_default_auto_cleanup_config() -> dict[str, Any]:
    """创建自动清理默认配置。"""
    return {
        "enabled": False,
        "intervalMinutes": AUTO_CLEANUP_DEFAULT_INTERVAL_MINUTES,
        "lastRunAt": "",
        "lastDeletedCount": 0,
    }


def merge_auto_cleanup_state(saved: dict[str, Any]) -> dict[str, Any]:
    """将持久化配置合并为运行时状态。"""
    state = create_auto_cleanup_state()
    state.update(create_default_auto_cleanup_config())
    state.update(saved)
    state["enabled"] = bool(state["enabled"])
    state["intervalMinutes"] = validate_cleanup_interval(int(state["intervalMinutes"]))
    state["lastRunAt"] = str(state["lastRunAt"] or "")
    state["lastDeletedCount"] = int(state["lastDeletedCount"] or 0)
    state["task"] = None
    return state


def validate_cleanup_interval(minutes: int) -> int:
    """校验自动清理间隔分钟数。"""
    if minutes < 1:
        raise HTTPException(status_code=400, detail="intervalMinutes must be greater than 0.")
    return minutes


def get_cleanup_cutoff() -> datetime:
    """返回系统自动清理默认时间阈值。"""
    return datetime.now(timezone.utc) - timedelta(minutes=AUTO_CLEANUP_DEFAULT_BEFORE_MINUTES)


def build_auto_cleanup_response(state: dict[str, Any]) -> dict[str, Any]:
    """构造自动清理状态响应。"""
    return {
        "enabled": bool(state["enabled"]),
        "intervalMinutes": int(state["intervalMinutes"]),
        "beforeMinutes": AUTO_CLEANUP_DEFAULT_BEFORE_MINUTES,
        "lastRunAt": str(state["lastRunAt"] or ""),
        "lastDeletedCount": int(state["lastDeletedCount"] or 0),
    }


def load_auto_cleanup_state() -> dict[str, Any]:
    """从数据库加载自动清理配置。"""
    sql = f"""
    SELECT enabled, interval_minutes, last_run_at, last_deleted_count
    FROM {TABLE_AUTO_CLEANUP} WHERE config_key = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [AUTO_CLEANUP_CONFIG_KEY])
            row = cur.fetchone()
    if not row:
        return merge_auto_cleanup_state(create_default_auto_cleanup_config())
    return merge_auto_cleanup_state({
        "enabled": row["enabled"],
        "intervalMinutes": row["interval_minutes"],
        "lastRunAt": isoformat_value(row.get("last_run_at")),
        "lastDeletedCount": row["last_deleted_count"],
    })


def save_auto_cleanup_state(state: dict[str, Any]) -> dict[str, Any]:
    """将自动清理配置持久化到数据库。"""
    sql = f"""
    INSERT INTO {TABLE_AUTO_CLEANUP} (
      config_key, enabled, interval_minutes, last_run_at, last_deleted_count, updated_at
    ) VALUES (%s, %s, %s, %s, %s, NOW())
    ON CONFLICT (config_key) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      interval_minutes = EXCLUDED.interval_minutes,
      last_run_at = EXCLUDED.last_run_at,
      last_deleted_count = EXCLUDED.last_deleted_count,
      updated_at = NOW()
    RETURNING enabled, interval_minutes, last_run_at, last_deleted_count;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [
                AUTO_CLEANUP_CONFIG_KEY,
                bool(state["enabled"]),
                validate_cleanup_interval(int(state["intervalMinutes"])),
                state["lastRunAt"] or None,
                int(state["lastDeletedCount"] or 0),
            ])
            row = cur.fetchone() or {}
        conn.commit()
    return merge_auto_cleanup_state({
        "enabled": row.get("enabled", False),
        "intervalMinutes": row.get("interval_minutes", AUTO_CLEANUP_DEFAULT_INTERVAL_MINUTES),
        "lastRunAt": isoformat_value(row.get("last_run_at")),
        "lastDeletedCount": row.get("last_deleted_count", 0),
    })


def ensure_schema() -> None:
    """初始化数据库表和索引。"""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(SQL_CREATE_TABLE)
            cur.execute(SQL_CREATE_INDEX_RECEIVED_AT)
            cur.execute(SQL_CREATE_INDEX_RCPT_TO_RECEIVED_AT)
            cur.execute(SQL_CREATE_AUTO_CLEANUP_TABLE)
            cur.execute(SQL_CREATE_ATTACHMENTS_TABLE)
            cur.execute(SQL_CREATE_INDEX_ATTACHMENTS_MAIL_ID)
        conn.commit()
    # 确保附件目录存在。
    os.makedirs(ATTACHMENTS_DIR, exist_ok=True)


def build_where_clause(filters: MailListFilters) -> tuple[str, list[Any]]:
    """根据查询条件构造 SQL WHERE 片段与绑定参数。"""
    conditions: list[str] = []
    values: list[Any] = []
    if filters.rcptTo:
        conditions.append("rcpt_to = %s")
        values.append(filters.rcptTo)
    if filters.after:
        conditions.append("received_at >= %s")
        values.append(filters.after)
    if filters.before:
        conditions.append("received_at <= %s")
        values.append(filters.before)
    return (f"WHERE {' AND '.join(conditions)}" if conditions else "", values)


def parse_filters(rcpt_to: str | None, after: str | None, before: str | None, page: int | None, page_size: int | None) -> MailListFilters:
    """解析并校验邮件列表查询参数。"""
    address = normalize_email_address(rcpt_to or "")
    if address and not is_valid_email_address(address):
        raise HTTPException(status_code=400, detail="Invalid 'rcptTo' email address.")
    after_value = parse_datetime_filter(after, "after")
    before_value = parse_datetime_filter(before, "before")
    if after_value and before_value and after_value > before_value:
        raise HTTPException(status_code=400, detail="'after' must be less than or equal to 'before'.")
    return MailListFilters(
        rcptTo=address,
        after=after_value,
        before=before_value,
        page=parse_positive_integer(page, DEFAULT_PAGE, 1, 10**9),
        pageSize=parse_positive_integer(page_size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    )


def map_mail_summary(row: dict[str, Any]) -> dict[str, Any]:
    """将数据库行映射为邮件列表摘要结构。"""
    return {
        "id": str(row["id"]),
        "messageId": str(row["message_id"]),
        "from": str(row["mail_from"]),
        "to": str(row["rcpt_to"]),
        "subject": str(row["subject"]),
        "date": str(row["date_header"]),
        "receivedAt": isoformat_value(row["received_at"]),
    }


def map_mail_detail(row: dict[str, Any]) -> dict[str, Any]:
    """将数据库行映射为邮件详情结构。"""
    raw_text = str(row.get("raw_text") or "")
    bodies = extract_mail_bodies(raw_text)
    return {
        "id": str(row["id"]),
        "messageId": str(row["message_id"]),
        "from": str(row["mail_from"]),
        "to": str(row["rcpt_to"]),
        "subject": str(row["subject"]),
        "date": str(row["date_header"]),
        "receivedAt": isoformat_value(row["received_at"]),
        "headers": row.get("headers_json") or {},
        "raw": raw_text,
        "textBody": bodies["textBody"],
        "htmlBody": bodies["htmlBody"],
    }


def count_mails(filters: MailListFilters) -> int:
    """统计满足条件的邮件总数。"""
    where_sql, values = build_where_clause(filters)
    sql = f"SELECT COUNT(*) AS total FROM {TABLE_MAILS} {where_sql};"
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, values)
            row = cur.fetchone() or {"total": 0}
    return int(row["total"] or 0)


def list_mails(filters: MailListFilters) -> list[dict[str, Any]]:
    """按分页条件查询邮件列表。"""
    where_sql, values = build_where_clause(filters)
    offset = (filters.page - 1) * filters.pageSize
    sql = f"""
    SELECT id, message_id, mail_from, rcpt_to, subject, date_header, received_at
    FROM {TABLE_MAILS} {where_sql}
    ORDER BY received_at DESC, id DESC
    LIMIT %s OFFSET %s;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [*values, filters.pageSize, offset])
            rows = cur.fetchall() or []
    return [map_mail_summary(row) for row in rows]


def get_mail_by_id(mail_id: str) -> dict[str, Any] | None:
    """根据邮件 ID 查询单封邮件详情。"""
    sql = f"""
    SELECT id, message_id, mail_from, rcpt_to, subject, date_header,
           received_at, headers_json, raw_text
    FROM {TABLE_MAILS} WHERE id = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [mail_id])
            return cur.fetchone()


def get_mail_by_id_and_address(address: str, mail_id: str) -> dict[str, Any] | None:
    """根据收件邮箱和邮件 ID 查询单封邮件详情。"""
    sql = f"""
    SELECT id, message_id, mail_from, rcpt_to, subject, date_header,
           received_at, headers_json, raw_text
    FROM {TABLE_MAILS} WHERE rcpt_to = %s AND id = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [address, mail_id])
            return cur.fetchone()


def list_attachments_by_mail(mail_id: str) -> list[dict[str, Any]]:
    """查询指定邮件的所有附件元数据。"""
    sql = f"""
    SELECT id, mail_id, filename, content_type, size_bytes, file_path, created_at
    FROM {TABLE_ATTACHMENTS} WHERE mail_id = %s ORDER BY created_at;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [mail_id])
            rows = cur.fetchall() or []
    return [map_attachment_row(r) for r in rows]


def map_attachment_row(row: dict[str, Any]) -> dict[str, Any]:
    """将数据库行映射为附件摘要结构。"""
    return {
        "id": str(row["id"]),
        "mailId": str(row["mail_id"]),
        "filename": str(row["filename"]),
        "contentType": str(row["content_type"]),
        "sizeBytes": int(row["size_bytes"]),
        "downloadUrl": f"/api/attachments/{row['id']}/download",
    }


def get_attachment_by_id(attachment_id: str) -> dict[str, Any] | None:
    """查询单条附件元数据。"""
    sql = f"""
    SELECT id, mail_id, filename, content_type, size_bytes, file_path
    FROM {TABLE_ATTACHMENTS} WHERE id = %s LIMIT 1;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [attachment_id])
            return cur.fetchone()


def _delete_attachment_files(file_paths: list[str]) -> None:
    """删除磁盘上的附件文件，忽略不存在的文件。"""
    for name in file_paths:
        path = os.path.join(ATTACHMENTS_DIR, name)
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def delete_attachments_before(before: datetime) -> list[str]:
    """查询并删除过期附件元数据，返回需删除的文件路径列表。"""
    sql = f"""
    DELETE FROM {TABLE_ATTACHMENTS}
    WHERE mail_id IN (SELECT id FROM {TABLE_MAILS} WHERE received_at < %s)
    RETURNING file_path;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [before])
            rows = cur.fetchall() or []
        conn.commit()
    return [str(r["file_path"]) for r in rows]


def delete_mails_before(before: datetime) -> int:
    """删除指定时间之前的历史邮件（含关联附件元数据）并返回删除数量。"""
    # 先收集需删除的附件文件路径，再删邮件（ON DELETE CASCADE 会级联删附件行）。
    file_paths = delete_attachments_before(before)
    sql = f"DELETE FROM {TABLE_MAILS} WHERE received_at < %s;"
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, [before])
            deleted = cur.rowcount
        conn.commit()
    _delete_attachment_files(file_paths)
    return int(deleted or 0)


async def run_auto_cleanup_once(state: dict[str, Any]) -> None:
    """执行一次后端自动清理任务。"""
    deleted = await run_in_threadpool(delete_mails_before, get_cleanup_cutoff())
    state["lastRunAt"] = isoformat_value(datetime.now(timezone.utc))
    state["lastDeletedCount"] = deleted
    saved = await run_in_threadpool(save_auto_cleanup_state, state)
    state.update(saved)


async def auto_cleanup_loop(state: dict[str, Any]) -> None:
    """按配置周期持续执行自动清理。"""
    while state["enabled"]:
        await asyncio.sleep(int(state["intervalMinutes"]) * 60)
        if state["enabled"]:
            await run_auto_cleanup_once(state)


async def replace_auto_cleanup_task(state: dict[str, Any]) -> None:
    """按当前状态重建自动清理后台任务。"""
    task = state.get("task")
    if task:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    state["task"] = asyncio.create_task(auto_cleanup_loop(state)) if state["enabled"] else None


def upsert_mail(payload: IngestEmailRequest) -> str:
    """解析原始邮件后写入或更新数据库，并提取附件落盘。"""
    rcpt_to = normalize_email_address(payload.rcptTo)
    if not is_valid_email_address(rcpt_to):
        raise HTTPException(status_code=400, detail="Invalid recipient address.")
    # 截断过大的原始邮件（不含附件部分）
    raw_text = truncate_text(payload.rawText or "", MAX_RAW_TEXT_LENGTH)
    message = parse_raw_message(raw_text)
    params = {
        "id": str(uuid4()),
        "message_id": extract_message_id(message),
        "mail_from": extract_header_address(message, "From") or normalize_email_address(payload.mailFrom),
        "rcpt_to": rcpt_to,
        "subject": extract_subject(message),
        "date_header": extract_date_header(message),
        "received_at": payload.receivedAt,
        "headers_json": dumps(extract_header_map(message), ensure_ascii=False),
        "raw_text": raw_text,
    }
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(SQL_INSERT_MAIL, params)
            row = cur.fetchone() or {"id": params["id"]}
        mail_id = str(row["id"])
        # 提取附件并在同一事务内写入元数据。
        attachments = extract_and_save_attachments(mail_id, payload.rawText or "")
        insert_attachments(conn, attachments)
        conn.commit()
    return mail_id


def render_console_page() -> str:
    """渲染控制台首页 HTML。"""
    return CONSOLE_PAGE_TEMPLATE.replace("__STYLE__", SHARED_PAGE_STYLE).replace("__SCRIPT__", CONSOLE_PAGE_SCRIPT)


def render_docs_page() -> str:
    """渲染文档页 HTML。"""
    return DOCS_PAGE_TEMPLATE.replace("__STYLE__", SHARED_PAGE_STYLE)


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
        task = app.state.auto_cleanup.get("task")
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


app = FastAPI(title="Mail Inbox Backend", docs_url="/openapi", redoc_url=None, lifespan=lifespan)


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


@app.get("/", response_class=HTMLResponse)
def handle_home_page() -> HTMLResponse:
    """返回邮件控制台首页。"""
    return HTMLResponse(render_console_page())


@app.get("/docs", response_class=HTMLResponse)
def handle_docs_page() -> HTMLResponse:
    """返回项目文档页。"""
    return HTMLResponse(render_docs_page())


@app.get("/healthz")
def handle_health() -> dict[str, Any]:
    """返回服务健康状态。"""
    return {"ok": True, "databaseConfigured": bool(DATABASE_URL)}


@app.post("/internal/emails")
def handle_ingest_email(payload: IngestEmailRequest, request: Request) -> dict[str, Any]:
    """接收 Worker 推送的邮件并写入数据库。"""
    require_api_token(request)
    mail_id = upsert_mail(payload)
    return {"ok": True, "id": mail_id}


@app.get("/api/auth/verify")
def handle_verify_api_token(request: Request) -> dict[str, Any]:
    """验证控制台使用的 API Token 是否有效。"""
    require_api_token(request)
    return {"ok": True, "message": "API token is valid."}


@app.get("/api/mails")
def handle_list_mails(
    request: Request,
    rcptTo: str | None = None,
    after: str | None = None,
    before: str | None = None,
    page: int | None = DEFAULT_PAGE,
    pageSize: int | None = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    """按筛选条件查询邮件列表。"""
    require_api_token(request)
    filters = parse_filters(rcptTo, after, before, page, pageSize)
    total = count_mails(filters)
    items = list_mails(filters)
    total_pages = (total + filters.pageSize - 1) // filters.pageSize if total else 0
    return {
        "filters": {"rcptTo": filters.rcptTo, "after": after, "before": before},
        "page": filters.page,
        "pageSize": filters.pageSize,
        "total": total,
        "totalPages": total_pages,
        "items": items,
    }


@app.get("/api/mails/{mail_id}")
def handle_get_mail_detail_by_id(mail_id: str, request: Request) -> dict[str, Any]:
    """按邮件 ID 查询邮件详情。"""
    require_api_token(request)
    mail = get_mail_by_id(mail_id)
    if not mail:
        raise HTTPException(status_code=404, detail="Mail not found.")
    return map_mail_detail(mail)


@app.get("/api/mail/{email}")
def handle_list_mails_by_address(
    email: str,
    request: Request,
    after: str | None = None,
    before: str | None = None,
    page: int | None = DEFAULT_PAGE,
    pageSize: int | None = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    """按收件邮箱查询邮件列表，兼容旧接口路径。"""
    require_api_token(request)
    filters = parse_filters(email, after, before, page, pageSize)
    total = count_mails(filters)
    items = list_mails(filters)
    total_pages = (total + filters.pageSize - 1) // filters.pageSize if total else 0
    return {
        "filters": {"rcptTo": filters.rcptTo, "after": after, "before": before},
        "page": filters.page,
        "pageSize": filters.pageSize,
        "total": total,
        "totalPages": total_pages,
        "items": items,
    }


@app.get("/api/mail/{email}/{mail_id}")
def handle_get_mail_detail_by_address(email: str, mail_id: str, request: Request) -> dict[str, Any]:
    """按收件邮箱和邮件 ID 查询邮件详情，兼容旧接口路径。"""
    require_api_token(request)
    address = normalize_email_address(email)
    if not is_valid_email_address(address):
        raise HTTPException(status_code=400, detail="Invalid email address.")
    mail = get_mail_by_id_and_address(address, mail_id)
    if not mail:
        raise HTTPException(status_code=404, detail="Mail not found.")
    return map_mail_detail(mail)


@app.get("/api/admin/auto-cleanup")
def handle_get_auto_cleanup_config(request: Request) -> dict[str, Any]:
    """返回当前自动清理配置。"""
    require_api_token(request)
    return build_auto_cleanup_response(request.app.state.auto_cleanup)


@app.put("/api/admin/auto-cleanup")
async def handle_update_auto_cleanup_config(
    request: Request,
    payload: AutoCleanupConfigRequest,
) -> dict[str, Any]:
    """更新后端自动清理配置。"""
    require_api_token(request)
    state = request.app.state.auto_cleanup
    state["enabled"] = bool(payload.enabled)
    state["intervalMinutes"] = validate_cleanup_interval(payload.intervalMinutes)
    saved = await run_in_threadpool(save_auto_cleanup_state, state)
    state.update(saved)
    await replace_auto_cleanup_task(state)
    return build_auto_cleanup_response(state)


@app.post("/api/admin/cleanup-history")
def handle_cleanup_history_mails(
    request: Request,
    payload: CleanupHistoryRequest | None = None,
) -> dict[str, Any]:
    """手动清理指定时间之前的历史邮件。"""
    require_api_token(request)
    before_value = payload.before if payload and payload.before else datetime.now(timezone.utc) - timedelta(minutes=MANUAL_CLEANUP_DEFAULT_MINUTES)
    deleted_count = delete_mails_before(before_value)
    return {"success": True, "before": isoformat_value(before_value), "deletedCount": deleted_count}


@app.get("/api/mails/{mail_id}/attachments")
def handle_list_attachments(mail_id: str, request: Request) -> dict[str, Any]:
    """返回指定邮件的附件列表。"""
    require_api_token(request)
    items = list_attachments_by_mail(mail_id)
    return {"mailId": mail_id, "items": items}


@app.get("/api/attachments/{attachment_id}/download")
def handle_download_attachment(attachment_id: str, request: Request) -> FileResponse:
    """下载指定附件文件。"""
    require_api_token(request)
    row = get_attachment_by_id(attachment_id)
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    file_path = os.path.join(ATTACHMENTS_DIR, str(row["file_path"]))
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Attachment file missing.")
    return FileResponse(
        path=file_path,
        media_type=str(row["content_type"]),
        filename=str(row["filename"]),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
