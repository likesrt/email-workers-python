/**
 * @typedef {Object} Env
 * @property {string} BACKEND_BASE_URL
 * @property {string} API_TOKEN
 */

/**
 * 将输入值安全转换为字符串。
 * @param {unknown} value
 * @param {string} [fallback=""]
 * @returns {string}
 */
function asString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * 读取邮件原始文本内容。
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
 * 读取并校验后端推送配置。
 * @param {Env} env
 * @returns {{ baseUrl: string; token: string }}
 */
function getBackendConfig(env) {
  const baseUrl = asString(env && env.BACKEND_BASE_URL, "").replace(/\/+$/, "");
  const token = asString(env && env.API_TOKEN, "");
  if (!baseUrl) throw new Error("BACKEND_BASE_URL is not configured.");
  if (!token) throw new Error("API_TOKEN is not configured.");
  return { baseUrl, token };
}

/**
 * 从 Cloudflare Email 事件构建后端写入 payload。
 * @param {any} message
 * @returns {Promise<object>}
 */
async function buildMailPayload(message) {
  return {
    mailFrom: asString(message && message.from, ""),
    rcptTo: asString(message && message.to, ""),
    receivedAt: new Date().toISOString(),
    rawText: await readRawEmailText(message),
  };
}

/**
 * 将邮件数据推送到 FastAPI 后端。
 * @param {Env} env
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function pushMailToBackend(env, payload) {
  const config = getBackendConfig(env);
  const response = await fetch(config.baseUrl + "/internal/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (response.ok) return;
  const text = await response.text();
  throw new Error("Backend ingest failed: " + response.status + " " + text);
}

/**
 * 在邮件处理失败时拒收本次邮件。
 * @param {any} message
 * @param {string} reason
 * @returns {void}
 */
function rejectMessage(message, reason) {
  try {
    if (message && typeof message.setReject === "function") {
      message.setReject(reason);
    }
  } catch {
    // ignore reject failure
  }
}

/**
 * 处理收到的邮件并转发到后端。
 * @param {any} message
 * @param {Env} env
 * @returns {Promise<void>}
 */
async function handleIncomingEmail(message, env) {
  try {
    const payload = await buildMailPayload(message);
    await pushMailToBackend(env, payload);
  } catch (error) {
    const messageText = error && error.message ? error.message : String(error);
    console.error("Failed to push incoming email:", error);
    rejectMessage(message, messageText);
  }
}

export default {
  /**
   * 处理 Cloudflare Email 入口事件。
   * @param {any} message
   * @param {Env} env
   * @returns {Promise<void>}
   */
  async email(message, env) {
    await handleIncomingEmail(message, env);
  },
};
