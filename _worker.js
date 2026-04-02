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

/**
 * 渲染首页 HTML
 * @returns {string}
 */
function renderHomePage() {
  
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email Workers Mail Query</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e5e7eb;
      line-height: 1.5;
    }
    .wrap {
      max-width: 1280px;
      margin: 0 auto;
      padding: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 16px;
    }
    @media (max-width: 980px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    .card {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 16px;
      backdrop-filter: blur(8px);
    }
    h1, h2, h3 {
      margin-top: 0;
      margin-bottom: 12px;
    }
    .muted {
      opacity: 0.8;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: end;
      margin-bottom: 12px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 160px;
      flex: 1 1 180px;
    }
    .field.wide {
      flex: 2 1 320px;
    }
    label {
      font-size: 13px;
      opacity: 0.9;
    }
    input, select, button, textarea {
      font: inherit;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.08);
      color: inherit;
      padding: 10px 12px;
      outline: none;
    }
    button {
      cursor: pointer;
      white-space: nowrap;
    }
    button.primary {
      background: #2563eb;
      border-color: #2563eb;
      color: #fff;
    }
    button.danger {
      background: #b91c1c;
      border-color: #b91c1c;
      color: #fff;
    }
    button.secondary {
      background: rgba(255,255,255,0.12);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .table-wrap {
      overflow-x: auto;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      vertical-align: top;
      font-size: 14px;
    }
    th {
      background: rgba(255,255,255,0.04);
      position: sticky;
      top: 0;
    }
    .subject {
      max-width: 360px;
      word-break: break-word;
    }
    .pill {
      display: inline-block;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.1);
    }
    .status {
      min-height: 24px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 14px;
    }
    pre {
      margin: 0;
      padding: 14px;
      border-radius: 12px;
      background: rgba(0,0,0,0.22);
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 68vh;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .pagination {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .small {
      font-size: 13px;
      opacity: 0.9;
    }
    .empty {
      padding: 16px;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Email Workers Mail Query</h1>
      <div class="muted">
        所有 API 都必须携带 Authorization: Bearer API_TOKEN。
        你可以在本页面输入并保存在浏览器本地，然后查询全部邮件、按收件邮箱筛选、按时间筛选、分页查看，并清理一天前的历史邮件。
      </div>
    </div>

    <div class="grid">
      <div>
        <div class="card">
          <h2>API_TOKEN</h2>
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
        </div>

        <div class="card">
          <h2>筛选与操作</h2>
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
          </div>

          <div class="toolbar">
            <button id="searchBtn" class="primary" type="button">查询邮件</button>
            <button id="cleanupBtn" class="danger" type="button">清理一天前历史邮件</button>
            <button id="resetFiltersBtn" class="secondary" type="button">重置筛选</button>
          </div>

          <div style="height:12px;"></div>

          <div class="pagination">
            <button id="prevPageBtn" class="secondary" type="button">上一页</button>
            <div class="field" style="min-width:110px;max-width:110px;">
              <label for="pageInput">页码</label>
              <input id="pageInput" type="number" min="1" value="1" />
            </div>
            <button id="jumpPageBtn" class="secondary" type="button">跳转</button>
            <button id="nextPageBtn" class="secondary" type="button">下一页</button>
            <span id="paginationInfo" class="pill">等待查询</span>
          </div>

          <div style="height:12px;"></div>
          <div id="status" class="status muted">请先输入并保存 API_TOKEN，再进行查询。</div>
        </div>

        <div class="card">
          <h2>邮件列表</h2>
          <div class="small muted">支持查看全部邮件，并按收件邮箱与时间范围筛选。</div>
          <div style="height:12px;"></div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>收到时间</th>
                  <th>收件邮箱</th>
                  <th>发件邮箱</th>
                  <th>主题</th>
                  <th>Message-ID</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="mailTableBody">
                <tr><td colspan="6" class="empty">暂无数据</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <h2>邮件详情</h2>
          <div class="small muted">点击列表中的“查看详情”后展示。</div>
          <div style="height:12px;"></div>
          <pre id="detailBox">暂无详情</pre>
        </div>

        <div class="card">
          <h2>接口示例</h2>
          <pre>GET  /api/auth/verify
GET  /api/mails?rcptTo=&after=&before=&page=1&pageSize=20
GET  /api/mails/{id}
POST /api/admin/cleanup-history

兼容接口：
GET /api/mail/{email}?after=&before=&page=1&pageSize=20
GET /api/mail/{email}/{id}</pre>
        </div>
      </div>
    </div>
  </div>

  <script>
    (function () {
      const STORAGE_TOKEN_KEY = "mail_worker_api_token";

      const tokenInput = document.getElementById("tokenInput");
      const saveTokenBtn = document.getElementById("saveTokenBtn");
      const verifyTokenBtn = document.getElementById("verifyTokenBtn");
      const clearTokenBtn = document.getElementById("clearTokenBtn");

      const rcptToInput = document.getElementById("rcptToInput");
      const afterInput = document.getElementById("afterInput");
      const beforeInput = document.getElementById("beforeInput");
      const pageSizeSelect = document.getElementById("pageSizeSelect");
      const pageInput = document.getElementById("pageInput");

      const searchBtn = document.getElementById("searchBtn");
      const cleanupBtn = document.getElementById("cleanupBtn");
      const resetFiltersBtn = document.getElementById("resetFiltersBtn");

      const prevPageBtn = document.getElementById("prevPageBtn");
      const jumpPageBtn = document.getElementById("jumpPageBtn");
      const nextPageBtn = document.getElementById("nextPageBtn");

      const paginationInfo = document.getElementById("paginationInfo");
      const status = document.getElementById("status");
      const mailTableBody = document.getElementById("mailTableBody");
      const detailBox = document.getElementById("detailBox");

      const state = {
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0,
        lastItems: []
      };

      function setStatus(message) {
        status.textContent = message;
      }

      function getSavedToken() {
        try {
          return localStorage.getItem(STORAGE_TOKEN_KEY) || "";
        } catch {
          return "";
        }
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
          setStatus("请先输入并保存 API_TOKEN。");
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
        if (!headers) {
          throw new Error("缺少 API_TOKEN");
        }

        const response = await fetch(path, {
          ...init,
          headers
        });

        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { rawText: text };
        }

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
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
      }

      function toIsoFromLocalInput(value) {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        return date.toISOString();
      }

      function renderTable(items) {
        if (!Array.isArray(items) || items.length === 0) {
          mailTableBody.innerHTML = '<tr><td colspan="6" class="empty">没有符合条件的邮件</td></tr>';
          return;
        }

        const rows = items.map(function (item) {
          return [
            "<tr>",
            "<td>", escapeHtml(formatDateTimeDisplay(item.receivedAt)), "</td>",
            "<td>", escapeHtml(item.to || ""), "</td>",
            "<td>", escapeHtml(item.from || ""), "</td>",
            '<td class="subject">', escapeHtml(item.subject || ""), "</td>",
            "<td>", escapeHtml(item.messageId || ""), "</td>",
            "<td><button class=\\"secondary detail-btn\\" type=\\"button\\" data-id=\\"",
            escapeHtml(item.id || ""),
            "\\">查看详情</button></td>",
            "</tr>"
          ].join("");
        }).join("");

        mailTableBody.innerHTML = rows;
      }

      function updatePaginationInfo() {
        paginationInfo.textContent =
          "第 " + state.page + " / " + (state.totalPages || 1) + " 页，共 " + state.total + " 封";
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

      async function loadMails(pageOverride) {
        try {
          const { params, page, pageSize } = getCurrentQueryParams(pageOverride);
          state.page = page;
          state.pageSize = pageSize;

          setStatus("查询中...");
          const data = await fetchJson("/api/mails?" + params.toString(), { method: "GET" });

          state.total = Number(data.total || 0);
          state.totalPages = Number(data.totalPages || 0);
          state.page = Number(data.page || page);
          state.pageSize = Number(data.pageSize || pageSize);
          state.lastItems = Array.isArray(data.items) ? data.items : [];

          renderTable(state.lastItems);
          updatePaginationInfo();
          setStatus("查询成功。");
        } catch (error) {
          renderTable([]);
          state.total = 0;
          state.totalPages = 0;
          updatePaginationInfo();
          setStatus("查询失败: " + (error && error.message ? error.message : String(error)));
        }
      }

      async function loadMailDetail(id) {
        try {
          detailBox.textContent = "详情加载中...";
          const data = await fetchJson("/api/mails/" + encodeURIComponent(id), { method: "GET" });
          detailBox.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          detailBox.textContent = "详情加载失败: " + (error && error.message ? error.message : String(error));
        }
      }

      async function verifyToken() {
        try {
          setStatus("正在验证 Token...");
          await fetchJson("/api/auth/verify", { method: "GET" });
          setStatus("Token 验证成功。");
        } catch (error) {
          setStatus("Token 验证失败: " + (error && error.message ? error.message : String(error)));
        }
      }

      async function cleanupHistoryMails() {
        const token = requireTokenOnClient();
        if (!token) return;

        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const confirmed = confirm(
          "确定清理一天前的所有历史邮件吗？\\n清理阈值: " + cutoff.toLocaleString()
        );
        if (!confirmed) return;

        try {
          setStatus("正在清理一天前历史邮件...");
          const data = await fetchJson("/api/admin/cleanup-history", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({})
          });

          setStatus(
            "清理完成。删除数量: " +
            String(data.deletedCount || 0) +
            "，阈值: " +
            String(data.before || "")
          );

          await loadMails(1);
        } catch (error) {
          setStatus("清理失败: " + (error && error.message ? error.message : String(error)));
        }
      }

      function resetFilters() {
        rcptToInput.value = "";
        afterInput.value = "";
        beforeInput.value = "";
        pageSizeSelect.value = "20";
        pageInput.value = "1";
      }

      saveTokenBtn.addEventListener("click", function () {
        const token = getToken();
        if (!token) {
          setStatus("请输入 API_TOKEN 后再保存。");
          return;
        }
        saveToken(token);
        setStatus("API_TOKEN 已保存到本地浏览器。");
      });

      verifyTokenBtn.addEventListener("click", function () {
        verifyToken();
      });

      clearTokenBtn.addEventListener("click", function () {
        tokenInput.value = "";
        clearToken();
        setStatus("本地 API_TOKEN 已清空。");
      });

      searchBtn.addEventListener("click", function () {
        pageInput.value = "1";
        loadMails(1);
      });

      cleanupBtn.addEventListener("click", function () {
        cleanupHistoryMails();
      });

      resetFiltersBtn.addEventListener("click", function () {
        resetFilters();
        setStatus("筛选条件已重置。");
      });

      prevPageBtn.addEventListener("click", function () {
        if (state.page > 1) {
          loadMails(state.page - 1);
        }
      });

      nextPageBtn.addEventListener("click", function () {
        if (state.totalPages > 0 && state.page < state.totalPages) {
          loadMails(state.page + 1);
        }
      });

      jumpPageBtn.addEventListener("click", function () {
        const page = parseInt(pageInput.value || "1", 10) || 1;
        loadMails(page);
      });

      mailTableBody.addEventListener("click", function (event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const id = target.getAttribute("data-id");
        if (target.classList.contains("detail-btn") && id) {
          loadMailDetail(id);
        }
      });

      const savedToken = getSavedToken();
      if (savedToken) {
        tokenInput.value = savedToken;
        setStatus("已从本地读取 API_TOKEN，可以直接查询。");
      }
    })();
  </script>
</body>
</html>`;
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
  return new Response(renderHomePage(), HTML_RESPONSE_HEADERS);
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
    await ensureSchema(env.DB);

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