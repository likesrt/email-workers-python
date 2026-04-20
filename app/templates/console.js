    (function () {
      const STORAGE_TOKEN_KEY = "mail_worker_api_token";
      const STORAGE_MANUAL_CLEANUP_MINUTES_KEY = "mail_worker_manual_cleanup_minutes";
      const STORAGE_AUTO_CLEANUP_MINUTES_KEY = "mail_worker_auto_cleanup_minutes";
      const STORAGE_AUTO_REFRESH_KEY = "mail_worker_auto_refresh_on";
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
      const resetFiltersBtn = document.getElementById("resetFiltersBtn");
      const prevPageBtn = document.getElementById("prevPageBtn");
      const nextPageBtn = document.getElementById("nextPageBtn");
      const prevPageBtnTop = document.getElementById("prevPageBtnTop");
      const nextPageBtnTop = document.getElementById("nextPageBtnTop");
      const paginationInfo = document.getElementById("paginationInfo");
      const paginationInfoTop = document.getElementById("paginationInfoTop");
      const mailTableBody = document.getElementById("mailTableBody");
      const detailBlobUrls = [];
      const toggleFiltersBtn = document.getElementById("toggleFiltersBtn");
      const filterDetails = document.getElementById("filterDetails");
      const themeToggleBtn = document.getElementById("themeToggleBtn");
      const state = { page: 1, pageSize: 20, total: 0, totalPages: 0, lastItems: [], autoRefreshTimer: 0, autoRefreshCountdownTimer: 0, autoRefreshRemainingSeconds: 0, autoCleanupCountdownTimer: 0, autoCleanupRemainingSeconds: 0, isAutoRefreshOn: true, isAutoCleanupOn: false, isLoadingMails: false, isCleaningUp: false, autoCleanupConfiguredMinutes: 10, autoCleanupLastRunAt: "", autoCleanupLastDeletedCount: 0 };
      const STORAGE_THEME_KEY = "mail_worker_theme";

      function initTheme() {
        const savedTheme = getSavedValue(STORAGE_THEME_KEY, null);
        const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        const defaultTheme = savedTheme || (prefersDark ? "dark" : "light");
        document.documentElement.dataset.theme = defaultTheme;
        if (themeToggleBtn) updateThemeIcon(defaultTheme);
      }

      function updateThemeIcon(theme) {
        if (!themeToggleBtn) return;
        if (theme === "light") {
          themeToggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>'; // moon icon for switching to dark
          themeToggleBtn.title = "切换至暗色模式";
        } else {
          themeToggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="4.22" x2="19.78" y2="5.64"></line></svg>'; // sun icon for switching to light
          themeToggleBtn.title = "切换至亮色模式";
        }
      }

      function toggleTheme() {
        const current = document.documentElement.dataset.theme || "dark";
        const next = current === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        saveValue(STORAGE_THEME_KEY, next);
        updateThemeIcon(next);
      }

      if (themeToggleBtn) {
        themeToggleBtn.addEventListener("click", toggleTheme);
      }
      initTheme();

      window.addEventListener("storage", function(event) {
        if (event.key === STORAGE_THEME_KEY && event.newValue) {
          document.documentElement.dataset.theme = event.newValue;
          updateThemeIcon(event.newValue);
        }
      });

      function loadAutoRefreshState() {
        const saved = getSavedValue(STORAGE_AUTO_REFRESH_KEY, null);
        if (saved !== null) state.isAutoRefreshOn = saved === "1";
      }

      function saveAutoRefreshState() {
        saveValue(STORAGE_AUTO_REFRESH_KEY, state.isAutoRefreshOn ? "1" : "0");
      }

      loadAutoRefreshState();

      function toggleFiltersBtnHandler() {
        filterDetails.hidden = !filterDetails.hidden;
        toggleFiltersBtn.textContent = filterDetails.hidden ? "更多筛选" : "收起筛选";

        // PC端展开时取消固定，折叠时固定
        const filterPanel = document.querySelector(".filter-panel");
        if (filterPanel) {
          filterPanel.setAttribute("data-expanded", !filterDetails.hidden);
        }
      }

      toggleFiltersBtn.addEventListener("click", toggleFiltersBtnHandler);


      function setStatus(target, message, kind) {
        target.textContent = message;
        target.dataset.kind = kind || "info";
      }

      function setAuthStatus(message, kind) {
        setActionStatus(message, kind);
      }

      function setActionStatus(message, kind) {
        if (!message) return;
        const container = document.getElementById("toastContainer");
        if (!container) return;

        const toast = document.createElement("div");
        toast.className = "toast";
        toast.dataset.kind = kind || "info";

        // Add icon based on kind
        let icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
        if (kind === "success") icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
        if (kind === "warning") icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
        if (kind === "error") icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';

        toast.innerHTML = `<span style="display:flex;align-items:center;">${icon}</span> <span>${message}</span>`;
        container.appendChild(toast);

        // Remove after 3 seconds
        setTimeout(() => {
          toast.classList.add("hiding");
          setTimeout(() => {
            if (toast.parentNode) toast.remove();
          }, 300); // Wait for animation
        }, 3000);
      }

      function getAutoRefreshSeconds() {
        const seconds = parseInt(autoRefreshSecondsInput.value || "0", 10) || 0;
        return seconds >= 1 ? seconds : 3;
      }

      function updateAutoRefreshButton() {
        toggleAutoRefreshBtn.textContent = state.isAutoRefreshOn ? "停止自动刷新" : "开启自动刷新";
      }

      function updateAutoCleanupButton() {
        toggleAutoCleanupBtn.textContent = state.isAutoCleanupOn ? "停止系统自动清理" : "开启系统自动清理";
      }

      function updateAutoRefreshStatus() {
        if (!state.isAutoRefreshOn) {
          autoRefreshStatus.textContent = "自动刷新：已停止";
          autoRefreshCell.dataset.active = "0";
          return;
        }
        autoRefreshStatus.textContent = "自动刷新：" + state.autoRefreshRemainingSeconds + "s";
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


      function renderTable(items) {
        if (!Array.isArray(items) || items.length === 0) {
          mailTableBody.innerHTML = '<tr><td colspan="5" class="empty">没有符合条件的邮件</td></tr>';
          return;
        }
        const rows = items.map(function (item) {
          return [
            '<tr>',
            '<td class="col-time">', escapeHtml(formatDateTimeDisplay(item.receivedAt)), '</td>',
            '<td class="col-to">', escapeHtml(item.to || "-"), '</td>',
            '<td class="col-from">', escapeHtml(item.from || "-"), '</td>',
            '<td class="col-subject">', escapeHtml(item.subject || "-"), '</td>',
            '<td class="col-actions"><button class="secondary detail-btn" type="button" data-id="', escapeHtml(item.id || ""), '">详情</button></td>',
            '</tr>'
          ].join("");
        }).join("");
        mailTableBody.innerHTML = rows;
      }

      function updatePaginationInfo() {
        const info = "第 " + state.page + " / " + (state.totalPages || 1) + " 页，共 " + state.total + " 封";
        const prevDisabled = state.page <= 1;
        const nextDisabled = state.totalPages === 0 || state.page >= state.totalPages;
        paginationInfo.textContent = info;
        paginationInfoTop.textContent = info;
        prevPageBtn.disabled = prevDisabled;
        nextPageBtn.disabled = nextDisabled;
        prevPageBtnTop.disabled = prevDisabled;
        nextPageBtnTop.disabled = nextDisabled;
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
        window.open('/detail?id=' + encodeURIComponent(id), '_blank');
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
        saveAutoRefreshState();
        syncAutoRefresh();
        setActionStatus(state.isAutoRefreshOn ? "自动刷新已开启。" : "自动刷新已停止。", "info");
      });
      autoRefreshSecondsInput.addEventListener("change", function () {
        const seconds = getAutoRefreshSeconds();
        autoRefreshSecondsInput.value = String(seconds);
        saveValue(STORAGE_AUTO_REFRESH_SECONDS_KEY, autoRefreshSecondsInput.value);
        syncAutoRefresh();
        setActionStatus("自动刷新间隔已更新为 " + seconds + " 秒。", "info");
      });
      resetFiltersBtn.addEventListener("click", function () {
        resetFilters();
        setActionStatus("筛选条件已重置。", "info");
      });
      function goToPrevPage() { if (state.page > 1) loadMails(state.page - 1); }
      function goToNextPage() { if (state.totalPages > 0 && state.page < state.totalPages) loadMails(state.page + 1); }
      prevPageBtn.addEventListener("click", goToPrevPage);
      nextPageBtn.addEventListener("click", goToNextPage);
      prevPageBtnTop.addEventListener("click", goToPrevPage);
      nextPageBtnTop.addEventListener("click", goToNextPage);
      mailTableBody.addEventListener("click", function (event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const button = target.closest(".detail-btn");
        if (button instanceof HTMLElement) {
          const id = button.getAttribute("data-id");
          if (id) loadMailDetail(id);
        }
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
