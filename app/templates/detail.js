(function () {
  const STORAGE_TOKEN_KEY = "mail_worker_api_token";
  const STORAGE_THEME_KEY = "mail_worker_theme";

  const themeToggleBtn = document.getElementById("themeToggleBtn");
  const detailTitle = document.getElementById("detailTitle");
  const detailMeta = document.getElementById("detailMeta");
  const detailBody = document.getElementById("detailBody");
  const detailHeaders = document.getElementById("detailHeaders");
  const detailAttachments = document.getElementById("detailAttachments");
  const detailRaw = document.getElementById("detailRaw");
  const loadRawBtn = document.getElementById("loadRawBtn");

  const state = { detailBlobUrls: [], mailId: "", rawLoaded: false };

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
      themeToggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
      themeToggleBtn.title = "切换至暗色模式";
    } else {
      themeToggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="4.22" x2="19.78" y2="5.64"></line></svg>';
      themeToggleBtn.title = "切换至亮色模式";
    }
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    saveValue(STORAGE_THEME_KEY, next);
    updateThemeIcon(next);
    updateIframeTheme(next);
  }

  function updateIframeTheme(theme) {
    // 移除iframe内的颜色动态修改，使内部背景始终保留纯白，避免破坏绝大部分邮件排版
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", toggleTheme);
  }
  initTheme();

  window.addEventListener("storage", function(event) {
    if (event.key === STORAGE_THEME_KEY && event.newValue) {
      document.documentElement.dataset.theme = event.newValue;
      updateThemeIcon(event.newValue);
      updateIframeTheme(event.newValue);
    }
  });

  function getSavedValue(key, fallback) {
    try { return localStorage.getItem(key) || fallback; }
    catch { return fallback; }
  }

  function saveValue(key, value) {
    try { localStorage.setItem(key, String(value)); }
    catch {}
  }

  function getToken() {
    try { return localStorage.getItem(STORAGE_TOKEN_KEY) || ""; }
    catch { return ""; }
  }

  function requireTokenOnClient() {
    const token = getToken();
    if (!token) {
      setActionStatus("未找到 API_TOKEN，请返回列表页输入保存。", "error");
      return "";
    }
    return token;
  }

  function setActionStatus(message, kind) {
    if (!message) return;
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.dataset.kind = kind || "info";

    let icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
    if (kind === "success") icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
    if (kind === "warning") icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
    if (kind === "error") icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';

    toast.innerHTML = `<span style="display:flex;align-items:center;">${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("hiding");
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, 300);
    }, 3000);
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

  /**
   * 为 cid 内嵌附件构建 blob URL 映射。
   * @param {Array<Record<string, any>>} attachments 当前邮件的附件列表。
   * @returns {Promise<Map<string, string>>} 以 content-id 为键的临时访问地址映射。
   * @remarks 使用并发下载减少多张内嵌图片邮件的首屏等待时间。
   */
  async function buildCidBlobUrlMap(attachments) {
    const cidMap = new Map();
    const inlineItems = (attachments || []).filter(function (item) {
      return String(item.contentId || "").trim() && String(item.disposition || "").toLowerCase() === "inline";
    });
    const entries = await Promise.all(inlineItems.map(async function (item) {
      const blob = await fetchBlob(String(item.downloadUrl || ""));
      const url = URL.createObjectURL(blob);
      return [String(item.contentId || "").trim().toLowerCase(), url];
    }));
    entries.forEach(function (entry) {
      state.detailBlobUrls.push(entry[1]);
      cidMap.set(entry[0], entry[1]);
    });
    return cidMap;
  }

  function buildHtmlPreviewDocument(value) {
    const cleanHtml = sanitizeHtml(value);
    return [
      '<!DOCTYPE html><html><head><meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<base target="_blank">',
      '<style>html,body{margin:0;padding:0;background:white;color:#111827;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;}body{padding:16px;line-height:1.6;}img{max-width:100%;height:auto;}table{max-width:100%;border-collapse:collapse;}pre{white-space:pre-wrap;word-break:break-word;}a{color:#2563eb;}</style>',
      '</head><body>',
      cleanHtml,
      '</body></html>'
    ].join("");
  }

  async function renderHtmlBody(value, attachments) {
    detailBody.innerHTML = '<iframe class="mail-html-frame" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts" referrerpolicy="no-referrer"></iframe>';
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
    let text = String(value || "").replace(/\n{3,}/g, "\n\n").trim();
    // First escape HTML to prevent XSS
    text = escapeHtml(text);
    // Then match URLs and convert to clickable links
    text = text.replace(/(https?:\/\/[^\s&<]+)/g, '<a href="$1" target="_blank" style="color: var(--accent-primary); text-decoration: underline;">$1</a>');
    return text;
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

  function renderHeaderTable(headers) {
    const entries = Object.entries(headers || {});
    if (entries.length === 0) return '<div class="small">暂无头信息</div>';
    return [
      '<table class="header-table"><tbody>',
      entries.map(function (entry) {
        return '<tr><td>' + escapeHtml(entry[0]) + '</td><td title="点击复制" data-copy="' + escapeHtml(entry[1]) + '">' + escapeHtml(entry[1]) + '</td></tr>';
      }).join(""),
      '</tbody></table>'
    ].join("");
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

  /**
   * 渲染邮件详情页主内容。
   * @param {Record<string, any>} data 邮件详情接口返回的数据。
   * @param {Array<Record<string, any>>} attachments 当前邮件的附件列表。
   * @returns {Promise<void>} 渲染完成后结束，无额外返回值。
   * @remarks 原始邮件正文改为按需加载，首屏只渲染可读内容与头信息。
   */
  async function renderMailDetail(data, attachments) {
    detailTitle.textContent = data.subject || "无主题";
    document.title = (data.subject || "邮件详情") + " - Email Workers";

    detailMeta.innerHTML = [
      renderMetaCard("发件人", data.from),
      renderMetaCard("收件人", data.to),
      renderMetaCard("接收时间", formatDateTimeDisplay(data.receivedAt || data.date)),
      renderMetaCard("日期头", data.date)
    ].join("");

    if (data.htmlBody) {
      await renderHtmlBody(data.htmlBody, attachments || []);
    } else {
      const htmlContent = cleanupBodyText(data.textBody || "");
      detailBody.innerHTML = htmlContent ? '<div style="white-space: pre-wrap; font-family: var(--font-sans);">' + htmlContent + '</div>' : "没有提取到可读正文。";
    }

    detailHeaders.innerHTML = renderHeaderTable(data.headers);
    detailRaw.textContent = "未加载";
  }

  /**
   * 按需加载原始邮件全文。
   * @returns {Promise<void>} 加载完成后结束，无额外返回值。
   * @remarks 仅在用户主动点击后请求 raw，避免详情页首屏下载大文本。
   */
  async function loadRawContent() {
    if (!state.mailId || state.rawLoaded) return;
    if (loadRawBtn) loadRawBtn.disabled = true;
    detailRaw.textContent = "原始内容加载中...";

    try {
        // raw 体积通常远大于正文摘要，这里延后请求，避免详情页打开时被大文本拖慢。
      const data = await fetchJson(
        "/api/mails/" + encodeURIComponent(state.mailId) + "?includeRaw=1",
        { method: "GET" }
      );
      detailRaw.textContent = data.raw || "暂无原始内容";
      state.rawLoaded = true;
      if (loadRawBtn) loadRawBtn.textContent = "原始内容已加载";
    } catch (error) {
      detailRaw.textContent = "原始内容加载失败: " + (error && error.message ? error.message : String(error));
      if (loadRawBtn) loadRawBtn.disabled = false;
    }
  }

  /**
   * 根据 URL 中的邮件 ID 加载详情与附件。
   * @returns {Promise<void>} 加载完成后结束，无额外返回值。
   * @remarks 首屏请求默认不带 raw，减少网络传输和页面等待时间。
   */
  async function loadMailDetail() {
    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get('id');

    if (!id) {
      detailTitle.textContent = "参数错误";
      detailBody.textContent = "未提供邮件 ID。";
      return;
    }

    state.mailId = id;

    try {
      detailTitle.textContent = "邮件详情加载中...";
      detailRaw.textContent = "未加载";
      if (loadRawBtn) loadRawBtn.disabled = false;

      const [data, attData] = await Promise.all([
        fetchJson("/api/mails/" + encodeURIComponent(id), { method: "GET" }),
        fetchJson("/api/mails/" + encodeURIComponent(id) + "/attachments", { method: "GET" })
      ]);

      const attachments = Array.isArray(attData.items) ? attData.items : [];
      state.rawLoaded = false;
      await renderMailDetail(data, attachments);
      renderAttachmentList(attachments);
    } catch (error) {
      detailTitle.textContent = "加载失败";
      detailBody.textContent = "详情加载失败: " + (error && error.message ? error.message : String(error));
      detailMeta.innerHTML = "";
      detailHeaders.innerHTML = "";
      detailAttachments.innerHTML = "";
      detailRaw.textContent = "";
      if (loadRawBtn) loadRawBtn.disabled = true;
    }
  }

  if (loadRawBtn) {
    loadRawBtn.addEventListener("click", function () {
      loadRawContent();
    });
  }

  detailHeaders.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const td = target.closest("td[data-copy]");
    if (!td) return;
    const value = td.getAttribute("data-copy") || "";
    if (!value) return;
    navigator.clipboard.writeText(value)
      .then(function() {
        setActionStatus("已复制 " + (td.previousElementSibling ? td.previousElementSibling.textContent : "此行") + " 的值。", "success");
      })
      .catch(function(err) {
        setActionStatus("复制失败: " + String(err), "error");
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

  window.addEventListener("unload", function () {
    state.detailBlobUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); }
      catch {}
    });
  });

  loadMailDetail();
})();
