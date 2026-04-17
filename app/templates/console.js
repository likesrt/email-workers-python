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
      const autoRefreshCell = document.getElementById("autoRefreshCell");
      const autoCleanupCell = document.getElementById("autoCleanupCell");
      const actionCell = document.getElementById("actionCell");
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
      const state = { page: 1, pageSize: 20, total: 0, totalPages: 0, lastItems: [], autoRefreshTimer: 0, autoRefreshCountdownTimer: 0, autoRefreshRemainingSeconds: 0, autoCleanupCountdownTimer: 0, autoCleanupRemainingSeconds: 0, isAutoRefreshOn: true, isAutoCleanupOn: false, isLoadingMails: false, isCleaningUp: false, autoCleanupConfiguredMinutes: 10, autoCleanupLastRunAt: "", autoCleanupLastDeletedCount: 0, detailBlobUrls: [] };

      function releaseDetailBlobUrls() {
        state.detailBlobUrls.forEach(function (url) {
          try { URL.revokeObjectURL(url); }
          catch {}
        });
        state.detailBlobUrls = [];
      }

      function setStatus(target, message, kind) {
        target.textContent = message;
        target.dataset.kind = kind || "info";
      }

      function setAuthStatus(message, kind) {
        setStatus(authStatus, message, kind);
      }

      function setActionStatus(message, kind) {
        actionStatus.textContent = message;
        /* 操作结果单元格高亮颜色跟随操作类型。 */
        actionCell.dataset.kind = kind || "info";
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
          autoRefreshStatus.textContent = "自动查询：已停止";
          autoRefreshCell.dataset.active = "0";
          return;
        }
        autoRefreshStatus.textContent = "自动查询：" + state.autoRefreshRemainingSeconds + "s";
        autoRefreshCell.dataset.active = "1";
      }

      function updateAutoCleanupStatus() {
        if (!state.isAutoCleanupOn) {
          autoCleanupStatus.textContent = "自动清理：已停止";
          autoCleanupCell.dataset.active = "0";
          return;
        }
        autoCleanupStatus.textContent = "自动清理：每" + state.autoCleanupConfiguredMinutes + "分钟，" + state.autoCleanupRemainingSeconds + "s后";
        autoCleanupCell.dataset.active = "1";
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

      async function fetchBlob(path) {
        const headers = buildAuthHeaders();
        if (!headers) throw new Error("缺少 API_TOKEN");
        const response = await fetch(path, { method: "GET", headers });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || ("下载失败，状态码 " + response.status));
        }
        return await response.blob();
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

      function rewriteCidUrls(html, cidMap) {
        const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
        doc.querySelectorAll("[src],[href]").forEach(function (node) {
          ["src", "href"].forEach(function (name) {
            const value = String(node.getAttribute(name) || "").trim();
            if (!value.toLowerCase().startsWith("cid:")) return;
            const cid = value.slice(4).trim().replace(/^<|>$/g, "").toLowerCase();
            const url = cidMap.get(cid);
            if (url) node.setAttribute(name, url);
          });
        });
        return doc.body ? doc.body.innerHTML : String(html || "");
      }

      async function buildCidBlobUrlMap(attachments) {
        const cidMap = new Map();
        const inlineItems = (attachments || []).filter(function (item) {
          return String(item.contentId || "").trim() && String(item.disposition || "").toLowerCase() === "inline";
        });
        for (const item of inlineItems) {
          const blob = await fetchBlob(String(item.downloadUrl || ""));
          const url = URL.createObjectURL(blob);
          state.detailBlobUrls.push(url);
          cidMap.set(String(item.contentId || "").trim().toLowerCase(), url);
        }
        return cidMap;
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

      async function renderHtmlBody(value, attachments) {
        detailBody.innerHTML = '<iframe class="mail-html-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>';
        const frame = detailBody.querySelector("iframe");
        if (!(frame instanceof HTMLIFrameElement)) return;
        const cidMap = await buildCidBlobUrlMap(attachments || []);
        const html = rewriteCidUrls(value, cidMap);
        frame.srcdoc = buildHtmlPreviewDocument(html);
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

      function getExtractionStatusMeta(item) {
        const status = String(item && item.extractionStatus || "pending");
        if (status === "failed") {
          return { label: "识别失败", kind: "failed" };
        }
        if (status === "done") {
          return { label: item && item.verificationCode ? "已识别" : "无验证码", kind: "done" };
        }
        return { label: "识别中", kind: "pending" };
      }

      function renderExtractionStatusCell(item) {
        const meta = getExtractionStatusMeta(item);
        const title = item && item.extractionError ? ' title="' + escapeHtml(item.extractionError) + '"' : "";
        return [
          '<td class="col-status"><span class="status-pill" data-kind="',
          escapeHtml(meta.kind),
          '"',
          title,
          '>',
          escapeHtml(meta.label),
          '</span></td>'
        ].join("");
      }

      function renderActionCell(item) {
        return [
          '<td class="col-actions"><div class="action-stack">',
          '<button class="secondary detail-btn" type="button" data-id="', escapeHtml(item.id || ""), '">查看详情</button>',
          '<button class="secondary retry-extraction-btn" type="button" data-id="', escapeHtml(item.id || ""), '">重新识别</button>',
          '</div></td>'
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
        releaseDetailBlobUrls();
      }

      function renderTable(items) {
        if (!Array.isArray(items) || items.length === 0) {
          mailTableBody.innerHTML = '<tr><td colspan="9" class="empty">没有符合条件的邮件</td></tr>';
          return;
        }
        const rows = items.map(function (item) {
          const codeCell = item.verificationCode
            ? renderCopyCell(item.verificationCode, 'col-code')
            : '<td class="col-code"><span class="small">-</span></td>';
          const urlCell = item.activationUrl
            ? '<td class="col-url"><a href="' + escapeHtml(item.activationUrl) + '" target="_blank" class="link-btn">打开</a></td>'
            : '<td class="col-url"><span class="small">-</span></td>';
          return [
            '<tr>',
            '<td class="col-time">', escapeHtml(formatDateTimeDisplay(item.receivedAt)), '</td>',
            '<td class="col-to">', escapeHtml(item.to || ""), '</td>',
            renderCopyCell(item.from, 'col-from'),
            renderCopyCell(item.subject, 'col-subject'),
            codeCell,
            renderExtractionStatusCell(item),
            urlCell,
            renderCopyCell(item.messageId, 'col-message-id'),
            renderActionCell(item),
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

      async function downloadAttachment(item) {
        const blob = await fetchBlob(String(item.downloadUrl || ""));
        const url = URL.createObjectURL(blob);
        try {
          const a = document.createElement("a");
          a.href = url;
          a.download = String(item.filename || "attachment");
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }
      }

      function renderAttachmentList(items) {
        const downloadable = (items || []).filter(function (a) {
          return String(a.disposition || "attachment").toLowerCase() === "attachment";
        });
        if (!Array.isArray(downloadable) || downloadable.length === 0) {
          detailAttachments.innerHTML = '<div class="small">无附件</div>';
          return;
        }
        // 每个附件渲染为一行下载按钮，下载时通过 fetch 携带 Bearer Token。
        detailAttachments.innerHTML = downloadable.map(function (a) {
          return [
            '<div class="attachment-row">',
            '<span class="attachment-name">' + escapeHtml(a.filename) + '</span>',
            '<span class="attachment-meta">' + escapeHtml(a.contentType) + ' · ' + formatFileSize(a.sizeBytes) + '</span>',
            '<button class="attachment-dl" type="button" data-attachment="' + escapeHtml(JSON.stringify(a)) + '">下载</button>',
            '</div>'
          ].join("");
        }).join("");
      }

      async function renderMailDetail(data, attachments) {
        detailTitle.textContent = data.subject || "邮件详情";
        detailMeta.innerHTML = [
          renderMetaCard("主题", data.subject),
          renderMetaCard("发件人", data.from),
          renderMetaCard("收件人", data.to),
          renderMetaCard("接收时间", formatDateTimeDisplay(data.receivedAt || data.date)),
          renderMetaCard("Message-ID", data.messageId),
          renderMetaCard("日期头", data.date),
          renderMetaCard("识别状态", getExtractionStatusMeta(data).label),
          renderMetaCard("识别时间", formatDateTimeDisplay(data.extractedAt || ""))
        ].join("");
        if (data.htmlBody) {
          await renderHtmlBody(data.htmlBody, attachments || []);
        } else {
          detailBody.textContent = cleanupBodyText(data.textBody || htmlToText(data.raw)) || "没有提取到可读正文。";
        }
        detailHeaders.innerHTML = renderHeaderTable(data.headers);
        if (data.extractionError) {
          detailHeaders.innerHTML = '<div class="small">识别错误: ' + escapeHtml(data.extractionError) + '</div>' + detailHeaders.innerHTML;
        }
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
          releaseDetailBlobUrls();
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
          const attachments = Array.isArray(attData.items) ? attData.items : [];
          await renderMailDetail(data, attachments);
          renderAttachmentList(attachments);
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

      async function retryExtraction(id) {
        try {
          setActionStatus("正在重新识别验证码...", "info");
          await fetchJson("/api/mails/" + encodeURIComponent(id) + "/retry-extraction", { method: "POST" });
          setActionStatus("已重新执行识别。", "success");
          await loadMails(state.page, { loadingText: "刷新中..." });
        } catch (error) {
          setActionStatus("重新识别失败: " + (error && error.message ? error.message : String(error)), "error");
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
        const detailButton = target.closest(".detail-btn");
        if (detailButton instanceof HTMLElement) {
          const id = detailButton.getAttribute("data-id");
          if (id) loadMailDetail(id);
          return;
        }
        const retryButton = target.closest(".retry-extraction-btn");
        if (retryButton instanceof HTMLElement) {
          const id = retryButton.getAttribute("data-id");
          if (id) retryExtraction(id);
          return;
        }
        const cell = target.closest(".copy-cell");
        if (!(cell instanceof HTMLElement)) return;
        const value = cell.getAttribute("data-copy") || "";
        copyCellValue(value).catch(function () {
          setActionStatus("复制失败，请手动选择内容。", "error");
        });
      });
      detailAttachments.addEventListener("click", function (event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const button = target.closest(".attachment-dl");
        if (!(button instanceof HTMLElement)) return;
        const raw = button.getAttribute("data-attachment") || "{}";
        let item = {};
        try { item = JSON.parse(raw); }
        catch { item = {}; }
        downloadAttachment(item).catch(function (error) {
          setActionStatus("附件下载失败: " + (error && error.message ? error.message : String(error)), "error");
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
