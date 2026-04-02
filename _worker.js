// =============================================================================
// # REGION 1: 类型定义 (JSDoc Type Definitions)
// =============================================================================

/**
 * @typedef {Object} MailRecord
 * @property {string} id
 * @property {string} messageId
 * @property {string} mailFrom
 * @property {string} rcptTo
 * @property {string} subject
 * @property {string} dateHeader
 * @property {string} receivedAt
 * @property {string} headersJson
 * @property {string} rawText
 */

/**
 * @typedef {Object} MailSummary
 * @property {string} id
 * @property {string} messageId
 * @property {string} from
 * @property {string} to
 * @property {string} subject
 * @property {string} date
 * @property {string} receivedAt
 */

/**
 * @typedef {Object} MailListFilters
 * @property {string} rcptTo
 * @property {string | null} after
 * @property {string | null} before
 * @property {number} page
 * @property {number} pageSize
 */

/**
 * @typedef {Object} Env
 * @property {D1Database} DB
 * @property {string} API_TOKEN
 */

// =============================================================================
// # REGION 2: 常量与配置 (Constants & Configuration)
// =============================================================================

const API_PREFIX = "/api";
const TABLE_MAILS = "received_mails";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_RAW_TEXT_LENGTH = 128 * 1024;
const CLEANUP_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

const HTML_RESPONSE_HEADERS = {
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
};

const SCRIPT_RESPONSE_HEADERS = {
  headers: {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
};

const JSON_RESPONSE_HEADERS = {
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
};

const SQL_CREATE_TABLE =
  `CREATE TABLE IF NOT EXISTS ${TABLE_MAILS} (` +
  `id TEXT PRIMARY KEY, ` +
  `message_id TEXT NOT NULL, ` +
  `mail_from TEXT NOT NULL, ` +
  `rcpt_to TEXT NOT NULL, ` +
  `subject TEXT NOT NULL, ` +
  `date_header TEXT NOT NULL, ` +
  `received_at TEXT NOT NULL, ` +
  `headers_json TEXT NOT NULL, ` +
  `raw_text TEXT NOT NULL` +
  `);`;

const SQL_CREATE_INDEX_RECEIVED_AT =
  `CREATE INDEX IF NOT EXISTS idx_${TABLE_MAILS}_received_at ON ${TABLE_MAILS} (received_at DESC);`;

const SQL_CREATE_INDEX_RCPT_TO_RECEIVED_AT =
  `CREATE INDEX IF NOT EXISTS idx_${TABLE_MAILS}_rcpt_to_received_at ON ${TABLE_MAILS} (rcpt_to, received_at DESC);`;

const SQL_INSERT_MAIL =
  `INSERT INTO ${TABLE_MAILS} (` +
  `id, message_id, mail_from, rcpt_to, subject, date_header, received_at, headers_json, raw_text` +
  `) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`;

const SQL_GET_MAIL_BY_ID =
  `SELECT id, message_id, mail_from, rcpt_to, subject, date_header, received_at, headers_json, raw_text ` +
  `FROM ${TABLE_MAILS} ` +
  `WHERE id = ? ` +
  `LIMIT 1;`;

const SQL_GET_MAIL_BY_ID_AND_ADDRESS =
  `SELECT id, message_id, mail_from, rcpt_to, subject, date_header, received_at, headers_json, raw_text ` +
  `FROM ${TABLE_MAILS} ` +
  `WHERE rcpt_to = ? AND id = ? ` +
  `LIMIT 1;`;

const SQL_DELETE_MAILS_BEFORE =
  `DELETE FROM ${TABLE_MAILS} WHERE received_at < ?;`;

// =============================================================================
// # REGION 3: 核心辅助函数 (Core Utility Functions)
// =============================================================================

/**
 * 模块级 schema 初始化缓存，避免重复执行建表
 * @type {Promise<void> | null}
 */
let schemaReadyPromise = null;

/**
 * 生成随机 ID
 * @returns {string}
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * 创建标准 JSON 响应
 * @param {object | any[]} body
 * @param {number} [status=200]
 * @returns {Response}
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    ...JSON_RESPONSE_HEADERS,
    status,
  });
}

/**
 * 创建标准错误响应
 * @param {string} message
 * @param {number} [status=500]
 * @returns {Response}
 */
function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

/**
 * 创建 HTTP Error 对象
 * @param {string} message
 * @param {number} [status=400]
 * @returns {Error & { status: number }}
 */
function createHttpError(message, status = 400) {
  const error = new Error(message);
  // @ts-ignore
  error.status = status;
  // @ts-ignore
  return error;
}

/**
 * 获取 Bearer Token
 * @param {Request} request
 * @returns {string}
 */
function getBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const prefix = "Bearer ";
  return authorization.startsWith(prefix)
    ? authorization.slice(prefix.length).trim()
    : "";
}

/**
 * 强制校验 API_TOKEN
 * 所有 API 路由都必须使用该校验
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Response | null}
 */
function requireApiToken(request, env) {
  if (!env.API_TOKEN || typeof env.API_TOKEN !== "string") {
    return errorResponse("API token is not configured on the server.", 500);
  }

  const token = getBearerToken(request);
  if (!token || token !== env.API_TOKEN) {
    return errorResponse("Unauthorized.", 401);
  }

  return null;
}

/**
 * 将值转为字符串
 * @param {unknown} value
 * @param {string} [fallback=""]
 * @returns {string}
 */
function asString(value, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value.trim() : fallback;
}

/**
 * 标准化邮箱地址
 * @param {string} address
 * @returns {string}
 */
function normalizeEmailAddress(address) {
  return address.trim().toLowerCase();
}

/**
 * 校验邮箱地址
 * @param {string} address
 * @returns {boolean}
 */
function isValidEmailAddress(address) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

/**
 * 解析正整数
 * @param {string | null} value
 * @param {number} fallback
 * @param {number} [min=1]
 * @param {number} [max=Number.MAX_SAFE_INTEGER]
 * @returns {number}
 */
function parsePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.floor(parsed);
  if (integer < min) return fallback;
  if (integer > max) return max;
  return integer;
}

/**
 * 解析时间筛选参数并转为 ISO 字符串
 * @param {string | null} value
 * @param {string} label
 * @returns {string | null}
 */
function parseDateTimeFilter(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createHttpError(`Invalid '${label}' datetime.`, 400);
  }
  return date.toISOString();
}

/**
 * 将任意 headers 输入转为 Headers
 * @param {Headers | Record<string, string> | Iterable<[string, string]> | null | undefined} value
 * @returns {Headers}
 */
function toHeaders(value) {
  try {
    return value instanceof Headers ? value : new Headers(value || undefined);
  } catch {
    return new Headers();
  }
}

/**
 * 将 Headers 转为普通对象
 * @param {Headers} headers
 * @returns {Record<string, string>}
 */
function headersToObject(headers) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}

/**
 * 从邮件头提取 Subject
 * @param {Headers} headers
 * @returns {string}
 */
function getSubjectFromHeaders(headers) {
  return headers.get("subject") || "(no subject)";
}

/**
 * 从邮件头提取 Date
 * @param {Headers} headers
 * @returns {string}
 */
function getDateHeaderFromHeaders(headers) {
  return headers.get("date") || "";
}

/**
 * 从邮件头提取 Message-ID
 * @param {Headers} headers
 * @returns {string}
 */
function getMessageIdFromHeaders(headers) {
  return headers.get("message-id") || generateId();
}

/**
 * 读取邮件原始文本
 * @param {any} message
 * @returns {Promise<string>}
 */
async function readRawEmailText(message) {
  try {
    if (!message || !message.raw) return "";
    return await new Response(message.raw).text();
  } catch {
    return "";
  }
}

/**
 * 截断过长文本，避免 D1 体积过快膨胀
 * @param {string} value
 * @param {number} maxLength
 * @returns {string}
 */
function truncateText(value, maxLength) {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

/**
 * 将数据库行映射为摘要对象
 * @param {any} row
 * @returns {MailSummary}
 */
function mapMailSummary(row) {
  return {
    id: String(row.id || ""),
    messageId: String(row.message_id || ""),
    from: String(row.mail_from || ""),
    to: String(row.rcpt_to || ""),
    subject: String(row.subject || ""),
    date: String(row.date_header || ""),
    receivedAt: String(row.received_at || ""),
  };
}

/**
 * 根据绑定参数返回 statement
 * @param {D1Database} db
 * @param {string} sql
 * @param {any[]} bindings
 * @returns {D1PreparedStatement}
 */
function prepareWithBindings(db, sql, bindings) {
  const statement = db.prepare(sql);
  return bindings.length > 0 ? statement.bind(...bindings) : statement;
}

/**
 * 从 URL 查询参数中解析筛选条件
 * @param {URL} url
 * @param {string} [forcedRcptTo=""]
 * @returns {MailListFilters}
 */
function parseMailListFilters(url, forcedRcptTo = "") {
  const page = parsePositiveInteger(url.searchParams.get("page"), DEFAULT_PAGE, 1);
  const pageSize = parsePositiveInteger(
    url.searchParams.get("pageSize"),
    DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE
  );

  const rcptToRaw = forcedRcptTo || asString(url.searchParams.get("rcptTo"), "");
  const rcptTo = rcptToRaw ? normalizeEmailAddress(rcptToRaw) : "";

  if (rcptTo && !isValidEmailAddress(rcptTo)) {
    throw createHttpError("Invalid 'rcptTo' email address.", 400);
  }

  const after = parseDateTimeFilter(url.searchParams.get("after"), "after");
  const before = parseDateTimeFilter(url.searchParams.get("before"), "before");

  if (after && before && after > before) {
    throw createHttpError("'after' must be less than or equal to 'before'.", 400);
  }

  return {
    rcptTo,
    after,
    before,
    page,
    pageSize,
  };
}

/**
 * 构造 WHERE 片段和绑定值
 * @param {MailListFilters} filters
 * @returns {{ whereSql: string; bindings: any[] }}
 */
function buildMailWhereClause(filters) {
  /** @type {string[]} */
  const conditions = [];
  /** @type {any[]} */
  const bindings = [];

  if (filters.rcptTo) {
    conditions.push("rcpt_to = ?");
    bindings.push(filters.rcptTo);
  }

  if (filters.after) {
    conditions.push("received_at >= ?");
    bindings.push(filters.after);
  }

  if (filters.before) {
    conditions.push("received_at <= ?");
    bindings.push(filters.before);
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    bindings,
  };
}


const SHARED_PAGE_STYLE = `
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
    .pagination-field {
      display: grid;
      gap: 8px;
      width: 120px;
      margin: 0;
    }
    .pagination-field input {
      min-height: 46px;
      text-align: center;
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
    .raw-box,
    .code-box {
      margin: 0;
      padding: 16px;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.07);
      background: rgba(4, 9, 18, 0.88);
      color: #dce7f8;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: "JetBrains Mono", "Fira Code", monospace;
      overflow: auto;
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
      .pagination-field {
        width: 100%;
        max-width: none;
      }
      h1 {
        font-size: 38px;
      }
      .modal-backdrop {
        padding: 12px;
      }
    }
`;

const CONSOLE_PAGE_SCRIPT = String.raw`
    (function () {
      const STORAGE_TOKEN_KEY = "mail_worker_api_token";
      const STORAGE_CLEANUP_MINUTES_KEY = "mail_worker_cleanup_minutes";
      const STORAGE_AUTO_REFRESH_SECONDS_KEY = "mail_worker_auto_refresh_seconds";
      const tokenInput = document.getElementById("tokenInput");
      const saveTokenBtn = document.getElementById("saveTokenBtn");
      const verifyTokenBtn = document.getElementById("verifyTokenBtn");
      const clearTokenBtn = document.getElementById("clearTokenBtn");
      const rcptToInput = document.getElementById("rcptToInput");
      const afterInput = document.getElementById("afterInput");
      const beforeInput = document.getElementById("beforeInput");
      const pageSizeSelect = document.getElementById("pageSizeSelect");
      const cleanupMinutesInput = document.getElementById("cleanupMinutesInput");
      const autoRefreshSecondsInput = document.getElementById("autoRefreshSecondsInput");
      const pageInput = document.getElementById("pageInput");
      const searchBtn = document.getElementById("searchBtn");
      const cleanupBtn = document.getElementById("cleanupBtn");
      const toggleAutoCleanupBtn = document.getElementById("toggleAutoCleanupBtn");
      const toggleAutoRefreshBtn = document.getElementById("toggleAutoRefreshBtn");
      const autoRefreshStatus = document.getElementById("autoRefreshStatus");
      const autoCleanupStatus = document.getElementById("autoCleanupStatus");
      const resetFiltersBtn = document.getElementById("resetFiltersBtn");
      const prevPageBtn = document.getElementById("prevPageBtn");
      const jumpPageBtn = document.getElementById("jumpPageBtn");
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
      const detailRaw = document.getElementById("detailRaw");
      const closeDetailBtn = document.getElementById("closeDetailBtn");
      const closeDetailBtn2 = document.getElementById("closeDetailBtn2");
      const state = { page: 1, pageSize: 20, total: 0, totalPages: 0, lastItems: [], autoRefreshTimer: 0, autoRefreshCountdownTimer: 0, autoRefreshRemainingSeconds: 0, autoCleanupTimer: 0, autoCleanupCountdownTimer: 0, autoCleanupRemainingSeconds: 0, isAutoRefreshOn: true, isAutoCleanupOn: false, isLoadingMails: false, isCleaningUp: false };

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
        toggleAutoCleanupBtn.textContent = state.isAutoCleanupOn ? "停止自动清理" : "开启自动清理";
      }

      function updateAutoRefreshStatus() {
        if (!state.isAutoRefreshOn) {
          autoRefreshStatus.textContent = "自动查询已停止。";
          return;
        }
        autoRefreshStatus.textContent = "收件中，" + state.autoRefreshRemainingSeconds + " 秒后自动查询";
      }

      function updateAutoCleanupStatus() {
        if (!state.isAutoCleanupOn) {
          autoCleanupStatus.textContent = "自动清理已停止。";
          return;
        }
        autoCleanupStatus.textContent = "自动清理已开启，" + state.autoCleanupRemainingSeconds + " 秒后清理 " + cleanupMinutesInput.value + " 分钟前的历史邮件";
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
        if (state.autoCleanupTimer) {
          clearInterval(state.autoCleanupTimer);
          state.autoCleanupTimer = 0;
        }
        stopAutoCleanupCountdown();
      }

      function getCleanupMinutes() {
        const minutes = parseInt(cleanupMinutesInput.value || "0", 10) || 0;
        return minutes >= 1 ? minutes : 10;
      }

      function saveCleanupMinutesInput() {
        const minutes = parseInt(cleanupMinutesInput.value || "0", 10) || 0;
        if (minutes >= 1) saveValue(STORAGE_CLEANUP_MINUTES_KEY, String(minutes));
      }

      function resetAutoRefreshCountdown() {
        state.autoRefreshRemainingSeconds = getAutoRefreshSeconds();
        updateAutoRefreshStatus();
      }

      function resetAutoCleanupCountdown() {
        state.autoCleanupRemainingSeconds = getCleanupMinutes() * 60;
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
            state.autoCleanupRemainingSeconds = getCleanupMinutes() * 60;
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
        const seconds = getCleanupMinutes() * 60;
        resetAutoCleanupCountdown();
        startAutoCleanupCountdown();
        state.autoCleanupTimer = window.setInterval(function () {
          if (!state.isAutoCleanupOn || document.hidden || state.isCleaningUp) return;
          cleanupHistoryMails({ isAuto: true });
          state.autoCleanupRemainingSeconds = seconds;
          updateAutoCleanupStatus();
        }, seconds * 1000);
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

      function decodeQuotedPrintable(text) {
        return String(text || "")
          .replace(/=\r?\n/g, "")
          .replace(/=([A-Fa-f0-9]{2})/g, function (_, hex) {
            return String.fromCharCode(parseInt(hex, 16));
          });
      }

      function htmlToText(value) {
        const doc = new DOMParser().parseFromString(String(value || ""), "text/html");
        return doc.body ? (doc.body.textContent || "") : String(value || "");
      }

      function splitRawContent(raw) {
        const parts = String(raw || "").split(/\r?\n\r?\n/);
        parts.shift();
        return parts.join("\n\n");
      }

      function cleanupBodyText(value) {
        return String(value || "")
          .replace(/^--.*$/gm, "")
          .replace(/^Content-[^\n]*$/gmi, "")
          .replace(/^charset=[^\n]*$/gmi, "")
          .replace(/^boundary=[^\n]*$/gmi, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

      function buildReadableBody(raw) {
        const body = splitRawContent(raw);
        const decoded = /=([A-Fa-f0-9]{2})/.test(body) ? decodeQuotedPrintable(body) : body;
        const plain = /<[a-z][\s\S]*>/i.test(decoded) ? htmlToText(decoded) : decoded;
        return cleanupBodyText(plain) || "没有提取到可读正文。";
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
        pageInput.value = String(state.page);
        prevPageBtn.disabled = state.page <= 1;
        nextPageBtn.disabled = state.totalPages === 0 || state.page >= state.totalPages;
      }

      function getCurrentQueryParams(pageOverride) {
        const params = new URLSearchParams();
        const rcptTo = rcptToInput.value.trim();
        const after = toIsoFromLocalInput(afterInput.value);
        const before = toIsoFromLocalInput(beforeInput.value);
        const page = pageOverride || parseInt(pageInput.value || "1", 10) || 1;
        const pageSize = parseInt(pageSizeSelect.value || "20", 10) || 20;
        if (rcptTo) params.set("rcptTo", rcptTo);
        if (after) params.set("after", after);
        if (before) params.set("before", before);
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
        return { params, page, pageSize };
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
        detailBody.textContent = buildReadableBody(data.raw);
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
          setActionStatus(loadingText, "info");
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
          detailRaw.textContent = "";
          openDetailModal();
          const data = await fetchJson("/api/mails/" + encodeURIComponent(id), { method: "GET" });
          renderMailDetail(data);
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

      async function cleanupHistoryMails(options) {
        const token = requireTokenOnClient();
        if (!token) return;
        const isAuto = !!(options && options.isAuto);
        const minutes = getCleanupMinutes();
        if (minutes < 1) {
          setActionStatus("请输入大于 0 的清理分钟数。", "error");
          return;
        }
        const cutoff = new Date(Date.now() - minutes * 60 * 1000);
        if (!isAuto) {
          const confirmed = confirm("确定清理 " + minutes + " 分钟前的所有历史邮件吗？\n清理阈值: " + cutoff.toLocaleString());
          if (!confirmed) return;
        }
        state.isCleaningUp = true;
        try {
          setActionStatus((isAuto ? "自动" : "正在") + "清理 " + minutes + " 分钟前的历史邮件...", "info");
          const data = await fetchJson("/api/admin/cleanup-history", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ before: cutoff.toISOString() })
          });
          setActionStatus("清理完成。删除数量: " + String(data.deletedCount || 0) + "，阈值: " + String(data.before || ""), "success");
          await loadMails(1);
        } catch (error) {
          setActionStatus("清理失败: " + (error && error.message ? error.message : String(error)), "error");
        } finally {
          state.isCleaningUp = false;
        }
      }

      function resetFilters() {
        rcptToInput.value = "";
        afterInput.value = "";
        beforeInput.value = "";
        pageSizeSelect.value = "20";
        cleanupMinutesInput.value = "10";
        autoRefreshSecondsInput.value = "3";
        saveValue(STORAGE_CLEANUP_MINUTES_KEY, "10");
        saveValue(STORAGE_AUTO_REFRESH_SECONDS_KEY, "3");
        pageInput.value = "1";
        syncAutoRefresh();
        syncAutoCleanup();
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
        pageInput.value = "1";
        loadMails(1);
      });
      cleanupBtn.addEventListener("click", function () { cleanupHistoryMails(); });
      cleanupMinutesInput.addEventListener("input", saveCleanupMinutesInput);
      cleanupMinutesInput.addEventListener("change", function () {
        cleanupMinutesInput.value = String(getCleanupMinutes());
        saveCleanupMinutesInput();
        syncAutoCleanup();
      });
      toggleAutoCleanupBtn.addEventListener("click", function () {
        state.isAutoCleanupOn = !state.isAutoCleanupOn;
        syncAutoCleanup();
        setActionStatus(state.isAutoCleanupOn ? "自动清理已开启。" : "自动清理已停止。", "info");
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
      jumpPageBtn.addEventListener("click", function () {
        loadMails(parseInt(pageInput.value || "1", 10) || 1);
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
        if (state.isAutoCleanupOn) syncAutoCleanup();
      });
      autoRefreshSecondsInput.value = getSavedValue(STORAGE_AUTO_REFRESH_SECONDS_KEY, "3");
      cleanupMinutesInput.value = getSavedValue(STORAGE_CLEANUP_MINUTES_KEY, "10");
      autoRefreshSecondsInput.value = String(getAutoRefreshSeconds());
      cleanupMinutesInput.value = String(getCleanupMinutes());
      syncAutoRefresh();
      syncAutoCleanup();
      const savedToken = getSavedToken();
      if (savedToken) {
        tokenInput.value = savedToken;
        setAuthStatus("已从本地读取 API_TOKEN，可以直接查询。", "success");
      }
    })();
`;

const CONSOLE_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email Workers Console</title>
  <style>${SHARED_PAGE_STYLE}</style>
</head>
<body>
  <div class="page-shell">
    <div class="wrap">
      <section class="hero panel">
        <div class="hero-copy">
          <span class="eyebrow">EMAIL WORKERS CONSOLE</span>
          <h1>邮件收件箱控制台</h1>
          <div class="hero-actions">
            <a class="nav-link primary" href="/docs">API 文档</a>
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
              <span class="pill">Filterable</span>
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
              <label for="cleanupMinutesInput">清理阈值(分钟)</label>
              <div class="section-note">页面打开时，开启自动清理后会按这里填写的分钟数作为执行间隔，并清理对应分钟数之前的历史邮件。</div>
              <input id="cleanupMinutesInput" type="number" min="1" value="10" />
            </div>
            <div class="field">
              <label for="autoRefreshSecondsInput">自动查询(秒)</label>
              <input id="autoRefreshSecondsInput" type="number" min="1" value="3" />
            </div>
          </div>
          <div class="toolbar">
            <button id="searchBtn" class="primary" type="button">查询邮件</button>
            <button id="toggleAutoRefreshBtn" class="secondary" type="button">停止自动查询</button>
            <button id="toggleAutoCleanupBtn" class="secondary" type="button">开启自动清理</button>
            <button id="cleanupBtn" class="danger" type="button">按分钟清理历史邮件</button>
            <button id="resetFiltersBtn" class="secondary" type="button">重置筛选</button>
          </div>
          <div class="status-shell">
            <div id="actionStatus" class="status muted" data-kind="info">查询、重置、清理与复制提示会显示在这里。</div>
          </div>
          <div class="status-shell">
            <div id="autoRefreshStatus" class="status muted" data-kind="info">收件中，3 秒后自动查询</div>
          </div>
          <div class="status-shell">
            <div id="autoCleanupStatus" class="status muted" data-kind="info">自动清理已停止。</div>
          </div>
          <div style="height: 16px;"></div>
          <div class="pagination">
            <button id="prevPageBtn" class="secondary" type="button">上一页</button>
            <div class="pagination-field">
              <label for="pageInput">页码</label>
              <input id="pageInput" type="number" min="1" value="1" />
            </div>
            <button id="jumpPageBtn" class="secondary" type="button">跳转</button>
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
          <div class="section-note">优先展示可读正文，头信息和原始内容放在下方。</div>
        </div>
        <button id="closeDetailBtn" class="secondary" type="button">关闭</button>
      </div>
      <div class="detail-grid">
        <div id="detailMeta" class="meta-grid"></div>
        <div class="detail-card">
          <strong>正文</strong>
          <pre id="detailBody" class="body-box">暂无详情</pre>
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

  <script>${CONSOLE_PAGE_SCRIPT}</script>
</body>
</html>`;

const DOCS_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email Workers Docs</title>
  <style>${SHARED_PAGE_STYLE}</style>
</head>
<body>
  <div class="page-shell">
    <div class="wrap">
      <section class="hero panel">
        <div class="hero-copy">
          <span class="eyebrow">API DOCUMENTATION</span>
          <h1>接口文档</h1>
          <p class="hero-text">文档页独立放在 <code>/docs</code>，这里只保留接口说明和浏览器/前端可直接复用的 fetch 示例。</p>
          <div class="top-links">
            <a class="nav-link primary" href="/">返回首页</a>
          </div>
        </div>
        <div class="panel-note">
          <strong>文档说明</strong>
          <div class="small">所有受保护接口都需要带上 <code>Authorization: Bearer API_TOKEN</code>。</div>
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
          <p>返回单封邮件的基础信息、头信息和原始内容。首页里的弹窗会基于这份数据整理出更易读的展示。</p>
          <pre class="code-box">fetch("/api/mails/MAIL_ID", {
  method: "GET",
  headers: {
    Authorization: "Bearer " + token
  }
});</pre>
        </section>

        <section class="doc-card">
          <h3>历史清理</h3>
          <div class="small">POST <code>/api/admin/cleanup-history</code></div>
          <p>默认清理一天前的历史邮件，也可传入 JSON body 指定 <code>before</code> 时间。</p>
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
</html>`;

function renderConsolePage() {
  return CONSOLE_PAGE_HTML;
}

function renderDocsPage() {
  return DOCS_PAGE_HTML;
}

// =============================================================================
// # REGION 4: 持久化逻辑 (D1 Persistence Logic)
// =============================================================================

/**
 * 确保 D1 schema 已存在
 * @param {D1Database} db
 * @returns {Promise<void>}
 */
async function ensureSchema(db) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.prepare(SQL_CREATE_TABLE).run();
      await db.prepare(SQL_CREATE_INDEX_RECEIVED_AT).run();
      await db.prepare(SQL_CREATE_INDEX_RCPT_TO_RECEIVED_AT).run();
    })().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  await schemaReadyPromise;
}

/**
 * 插入收到的邮件
 * @param {D1Database} db
 * @param {MailRecord} data
 * @returns {Promise<D1Result>}
 */
async function insertReceivedMail(db, data) {
  return db
    .prepare(SQL_INSERT_MAIL)
    .bind(
      data.id,
      data.messageId,
      data.mailFrom,
      data.rcptTo,
      data.subject,
      data.dateHeader,
      data.receivedAt,
      data.headersJson,
      data.rawText
    )
    .run();
}

/**
 * 查询邮件总数
 * @param {D1Database} db
 * @param {MailListFilters} filters
 * @returns {Promise<number>}
 */
async function countMails(db, filters) {
  const { whereSql, bindings } = buildMailWhereClause(filters);
  const sql = `SELECT COUNT(*) AS total FROM ${TABLE_MAILS} ${whereSql};`;
  const row = await prepareWithBindings(db, sql, bindings).first();
  return Number((row && row.total) || 0);
}

/**
 * 分页查询邮件列表
 * @param {D1Database} db
 * @param {MailListFilters} filters
 * @returns {Promise<MailSummary[]>}
 */
async function listMails(db, filters) {
  const { whereSql, bindings } = buildMailWhereClause(filters);
  const offset = (filters.page - 1) * filters.pageSize;

  const sql =
    `SELECT id, message_id, mail_from, rcpt_to, subject, date_header, received_at ` +
    `FROM ${TABLE_MAILS} ` +
    `${whereSql} ` +
    `ORDER BY received_at DESC, id DESC ` +
    `LIMIT ? OFFSET ?;`;

  const { results } = await prepareWithBindings(db, sql, [...bindings, filters.pageSize, offset]).all();
  return (results || []).map(mapMailSummary);
}

/**
 * 按 ID 查询单封邮件详情
 * @param {D1Database} db
 * @param {string} id
 * @returns {Promise<MailRecord | null>}
 */
async function getMailById(db, id) {
  const row = await db.prepare(SQL_GET_MAIL_BY_ID).bind(id).first();
  if (!row) return null;

  return {
    id: String(row.id || ""),
    messageId: String(row.message_id || ""),
    mailFrom: String(row.mail_from || ""),
    rcptTo: String(row.rcpt_to || ""),
    subject: String(row.subject || ""),
    dateHeader: String(row.date_header || ""),
    receivedAt: String(row.received_at || ""),
    headersJson: String(row.headers_json || "{}"),
    rawText: String(row.raw_text || ""),
  };
}

/**
 * 按收件邮箱和 ID 查询单封邮件详情
 * @param {D1Database} db
 * @param {string} address
 * @param {string} id
 * @returns {Promise<MailRecord | null>}
 */
async function getMailByIdAndAddress(db, address, id) {
  const row = await db.prepare(SQL_GET_MAIL_BY_ID_AND_ADDRESS).bind(address, id).first();
  if (!row) return null;

  return {
    id: String(row.id || ""),
    messageId: String(row.message_id || ""),
    mailFrom: String(row.mail_from || ""),
    rcptTo: String(row.rcpt_to || ""),
    subject: String(row.subject || ""),
    dateHeader: String(row.date_header || ""),
    receivedAt: String(row.received_at || ""),
    headersJson: String(row.headers_json || "{}"),
    rawText: String(row.raw_text || ""),
  };
}

/**
 * 删除某个时间之前的邮件
 * @param {D1Database} db
 * @param {string} beforeIso
 * @returns {Promise<number>}
 */
async function deleteMailsBefore(db, beforeIso) {
  const result = await db.prepare(SQL_DELETE_MAILS_BEFORE).bind(beforeIso).run();
  return Number((result && result.meta && result.meta.changes) || 0);
}

// =============================================================================
// # REGION 5: HTTP 请求处理器 (HTTP Request Handlers)
// =============================================================================

/**
 * 处理首页
 * @returns {Response}
 */
function handleHomePage() {
  return new Response(renderConsolePage(), HTML_RESPONSE_HEADERS);
}

/**
 * 处理文档页
 * @returns {Response}
 */
function handleDocsPage() {
  return new Response(renderDocsPage(), HTML_RESPONSE_HEADERS);
}

/**
 * 处理首页脚本
 * @returns {Response}
 */
function handleConsoleScript() {
  return new Response(CONSOLE_PAGE_SCRIPT, SCRIPT_RESPONSE_HEADERS);
}

/**
 * 验证 API_TOKEN 是否正确
 * 路由：GET /api/auth/verify
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function handleVerifyApiToken(request, env) {
  const authError = requireApiToken(request, env);
  if (authError) return authError;

  return jsonResponse({
    ok: true,
    message: "API token is valid.",
  });
}

/**
 * 处理邮件列表查询
 * 路由：GET /api/mails
 *
 * 支持：
 * - rcptTo
 * - after
 * - before
 * - page
 * - pageSize
 *
 * @param {Request} request
 * @param {Env} env
 * @param {string} [forcedRcptTo=""]
 * @returns {Promise<Response>}
 */
async function handleListMails(request, env, forcedRcptTo = "") {
  const authError = requireApiToken(request, env);
  if (authError) return authError;

  try {
    await ensureSchema(env.DB);

    const url = new URL(request.url);
    const filters = parseMailListFilters(url, forcedRcptTo);

    const [total, items] = await Promise.all([
      countMails(env.DB, filters),
      listMails(env.DB, filters),
    ]);

    const totalPages = total > 0 ? Math.ceil(total / filters.pageSize) : 0;

    return jsonResponse({
      filters: {
        rcptTo: filters.rcptTo,
        after: filters.after,
        before: filters.before,
      },
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages,
      items,
    });
  } catch (error) {
    const status = Number(error && error.status) || 500;
    console.error("Failed to list mails:", error);
    return errorResponse(
      status === 500 ? "Failed to query mails from the database." : String(error.message || "Bad request."),
      status
    );
  }
}

/**
 * 处理按 ID 查询邮件详情
 * 路由：GET /api/mails/{id}
 *
 * @param {Request} request
 * @param {Env} env
 * @param {string} id
 * @returns {Promise<Response>}
 */
async function handleGetMailDetailById(request, env, id) {
  const authError = requireApiToken(request, env);
  if (authError) return authError;

  try {
    await ensureSchema(env.DB);

    if (!id) {
      return errorResponse("Invalid mail id.", 400);
    }

    const mail = await getMailById(env.DB, id);
    if (!mail) {
      return errorResponse("Mail not found.", 404);
    }

    let parsedHeaders = {};
    try {
      parsedHeaders = JSON.parse(mail.headersJson);
    } catch {
      parsedHeaders = {};
    }

    return jsonResponse({
      id: mail.id,
      messageId: mail.messageId,
      from: mail.mailFrom,
      to: mail.rcptTo,
      subject: mail.subject,
      date: mail.dateHeader,
      receivedAt: mail.receivedAt,
      headers: parsedHeaders,
      raw: mail.rawText,
    });
  } catch (error) {
    console.error("Failed to get mail detail:", error);
    return errorResponse("Failed to query mail detail from the database.");
  }
}

/**
 * 处理兼容接口：按邮箱和 ID 查询详情
 * 路由：GET /api/mail/{email}/{id}
 *
 * @param {Request} request
 * @param {Env} env
 * @param {string} address
 * @param {string} id
 * @returns {Promise<Response>}
 */
async function handleGetMailDetailByAddress(request, env, address, id) {
  const authError = requireApiToken(request, env);
  if (authError) return authError;

  try {
    await ensureSchema(env.DB);

    const normalizedAddress = normalizeEmailAddress(address);
    if (!isValidEmailAddress(normalizedAddress)) {
      return errorResponse("Invalid email address.", 400);
    }
    if (!id) {
      return errorResponse("Invalid mail id.", 400);
    }

    const mail = await getMailByIdAndAddress(env.DB, normalizedAddress, id);
    if (!mail) {
      return errorResponse("Mail not found.", 404);
    }

    let parsedHeaders = {};
    try {
      parsedHeaders = JSON.parse(mail.headersJson);
    } catch {
      parsedHeaders = {};
    }

    return jsonResponse({
      id: mail.id,
      messageId: mail.messageId,
      from: mail.mailFrom,
      to: mail.rcptTo,
      subject: mail.subject,
      date: mail.dateHeader,
      receivedAt: mail.receivedAt,
      headers: parsedHeaders,
      raw: mail.rawText,
    });
  } catch (error) {
    console.error("Failed to get mail detail by address:", error);
    return errorResponse("Failed to query mail detail from the database.");
  }
}

/**
 * 处理清理历史邮件
 * 路由：POST /api/admin/cleanup-history
 *
 * 默认删除一天前的所有邮件。
 * 可选 JSON body:
 * {
 *   "before": "2025-01-01T00:00:00.000Z"
 * }
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function handleCleanupHistoryMails(request, env) {
  const authError = requireApiToken(request, env);
  if (authError) return authError;

  try {
    /** @type {{ before?: string } | null} */
    let payload = null;
    try {
      payload = await request.json();
    } catch {
      payload = null;
    }

    let beforeIso = "";
    if (payload && payload.before) {
      beforeIso = parseDateTimeFilter(payload.before, "before") || "";
    } else {
      beforeIso = new Date(Date.now() - CLEANUP_OLDER_THAN_MS).toISOString();
    }

    await ensureSchema(env.DB);
    const deletedCount = await deleteMailsBefore(env.DB, beforeIso);

    return jsonResponse({
      success: true,
      before: beforeIso,
      deletedCount,
    });
  } catch (error) {
    const status = Number(error && error.status) || 500;
    console.error("Failed to cleanup history mails:", error);
    return errorResponse(
      status === 500 ? "Failed to cleanup history mails." : String(error.message || "Bad request."),
      status
    );
  }
}

// =============================================================================
// # REGION 5.5: Email Workers 处理器 (Email Event Handler)
// =============================================================================

/**
 * 处理 Cloudflare Email Workers 收到的邮件并写入 D1
 *
 * @param {any} message
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @returns {Promise<void>}
 */
async function handleIncomingEmail(message, env, ctx) {
  try {
    await ensureSchema(env.DB);

    const headers = toHeaders(message && message.headers);
    const rawTextFull = await readRawEmailText(message);
    const rawText = truncateText(rawTextFull, MAX_RAW_TEXT_LENGTH);

    const rcptTo = normalizeEmailAddress(asString(message && message.to, ""));
    const mailFrom = normalizeEmailAddress(asString(message && message.from, ""));

    if (!rcptTo || !isValidEmailAddress(rcptTo)) {
      console.error("Invalid recipient address:", rcptTo);
      return;
    }

    const record = {
      id: generateId(),
      messageId: asString(getMessageIdFromHeaders(headers), generateId()),
      mailFrom,
      rcptTo,
      subject: asString(getSubjectFromHeaders(headers), "(no subject)"),
      dateHeader: asString(getDateHeaderFromHeaders(headers), ""),
      receivedAt: new Date().toISOString(),
      headersJson: JSON.stringify(headersToObject(headers)),
      rawText,
    };

    await insertReceivedMail(env.DB, record);
  } catch (error) {
    console.error("Failed to store incoming email:", error);
    try {
      if (message && typeof message.setReject === "function") {
        message.setReject("Failed to store incoming email.");
      }
    } catch {
      // 忽略二次错误
    }
  }
}

// =============================================================================
// # REGION 6: 路由分发与主入口 (Router & Main Entrypoint)
// =============================================================================

export default {
  /**
   * Worker 主 fetch 入口
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (path === "/" && method === "GET") {
      return handleHomePage();
    }

    if (path === "/docs" && method === "GET") {
      return handleDocsPage();
    }

    if (path === "/console.js" && method === "GET") {
      return handleConsoleScript();
    }

    if (path === `${API_PREFIX}/auth/verify` && method === "GET") {
      return handleVerifyApiToken(request, env);
    }

    if (path === `${API_PREFIX}/mails` && method === "GET") {
      return handleListMails(request, env);
    }

    if (path === `${API_PREFIX}/admin/cleanup-history` && method === "POST") {
      return handleCleanupHistoryMails(request, env);
    }

    if (method === "GET" && path.startsWith(`${API_PREFIX}/mails/`)) {
      const id = decodeURIComponent(path.slice(`${API_PREFIX}/mails/`.length)).trim();
      if (!id) return errorResponse("Route not found.", 404);
      return handleGetMailDetailById(request, env, id);
    }

    if (method === "GET" && path.startsWith(`${API_PREFIX}/mail/`)) {
      const remainder = path.slice(`${API_PREFIX}/mail/`.length);
      const segments = remainder.split("/").filter(Boolean).map((part) => decodeURIComponent(part));

      if (segments.length === 1) {
        return handleListMails(request, env, segments[0]);
      }

      if (segments.length === 2) {
        return handleGetMailDetailByAddress(request, env, segments[0], segments[1]);
      }

      return errorResponse("Route not found.", 404);
    }

    return errorResponse("Route not found.", 404);
  },

  /**
   * Worker 主 email 入口
   * @param {any} message
   * @param {Env} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<void>}
   */
  async email(message, env, ctx) {
    await handleIncomingEmail(message, env, ctx);
  },

};