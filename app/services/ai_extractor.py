from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx


logger = logging.getLogger(__name__)
RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}


def extract_with_ai(
    subject: str, body_text: str, config: dict[str, Any]
) -> dict[str, str | None]:
    """
    使用 AI 接口提取验证码和激活 URL。

    支持 OpenAI 和 Anthropic 兼容接口，并在超时、限流和服务端错误时按配置重试。

    Args:
        subject: 邮件主题
        body_text: 邮件正文
        config: AI 配置，包含 base_url、api_key、model、provider、timeout、retry_times

    Returns:
        包含 code 和 url 的字典，失败时字段为 None
    """
    provider = config.get("provider", "openai").lower()
    timeout = int(config.get("timeout", 10))
    retry_times = max(0, int(config.get("retry_times", 0)))

    try:
        if provider == "anthropic":
            return _extract_with_retries(
                subject,
                body_text,
                config,
                timeout,
                retry_times,
                _extract_with_anthropic,
            )
        return _extract_with_retries(
            subject,
            body_text,
            config,
            timeout,
            retry_times,
            _extract_with_openai,
        )
    except Exception as exc:
        logger.warning("AI 识别在重试后仍失败：%s", _format_ai_error(exc))
        return {"code": None, "url": None}


def _extract_with_retries(
    subject: str,
    body_text: str,
    config: dict[str, Any],
    timeout: int,
    retry_times: int,
    extractor: Any,
) -> dict[str, str | None]:
    """
    执行 AI 提取并在可重试错误上进行有限重试。

    Args:
        subject: 邮件主题
        body_text: 邮件正文
        config: AI 配置
        timeout: 单次请求超时秒数
        retry_times: 失败后的最大重试次数
        extractor: 单次提取函数

    Returns:
        包含 code 和 url 的字典

    Raises:
        原始异常：当错误不可重试或超过重试上限时抛出
    """
    for attempt in range(retry_times + 1):
        try:
            return extractor(subject, body_text, config, timeout)
        except Exception as exc:
            if attempt >= retry_times or not _is_retryable_error(exc):
                raise
            sleep_seconds = _get_retry_delay_seconds(attempt)
            logger.warning(
                "AI 识别第 %s 次失败，将在 %.1f 秒后重试：%s",
                attempt + 1,
                sleep_seconds,
                _format_ai_error(exc),
            )
            time.sleep(sleep_seconds)
    raise RuntimeError("AI 识别重试次数已耗尽。")


def _extract_with_openai(
    subject: str, body_text: str, config: dict[str, Any], timeout: int
) -> dict[str, str | None]:
    """
    使用 OpenAI 兼容接口提取验证码和 URL。

    Args:
        subject: 邮件主题
        body_text: 邮件正文
        config: AI 配置
        timeout: 超时时间（秒）

    Returns:
        包含 code 和 url 的字典
    """
    base_url = config.get("base_url", "")
    api_key = config.get("api_key", "")
    model = config.get("model", "gpt-4")
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    'Extract verification code and activation URL from email. '
                    'Only return a code when the email clearly presents it as a verification/login/security code. '
                    'Never return phone numbers, zip codes, prices, dates, discounts, or repeated dummy values like 000000. '
                    'Return JSON: {"code": null|string, "url": null|string}.'
                ),
            },
            {"role": "user", "content": f"Subject: {subject}\n\n{body_text}"},
        ],
        "response_format": {"type": "json_object"},
    }
    response = httpx.post(url, json=payload, headers=headers, timeout=timeout)
    response.raise_for_status()
    data = response.json()
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "{}")
    result = json.loads(content)
    return {"code": result.get("code"), "url": result.get("url")}


def _format_ai_error(exc: Exception) -> str:
    """
    将 AI 请求异常整理成便于排查的中文日志文本。

    Args:
        exc: AI 请求过程中抛出的异常

    Returns:
        适合直接写入日志的错误描述
    """
    if isinstance(exc, httpx.HTTPStatusError):
        response = exc.response
        body = _truncate_error_body(response.text)
        return f"HTTP {response.status_code}，响应体={body}"
    if isinstance(exc, httpx.TimeoutException):
        return "请求超时"
    if isinstance(exc, httpx.NetworkError):
        return f"网络错误：{exc}"
    return str(exc)


def _truncate_error_body(text: str) -> str:
    """
    截断错误响应体，避免日志被大段 HTML 或 JSON 淹没。

    Args:
        text: 原始响应体文本

    Returns:
        截断后的响应体
    """
    compact = " ".join(str(text or "").split())
    return compact[:300] or "<empty>"


def _extract_with_anthropic(
    subject: str, body_text: str, config: dict[str, Any], timeout: int
) -> dict[str, str | None]:
    """
    使用 Anthropic 接口提取验证码和 URL。

    Args:
        subject: 邮件主题
        body_text: 邮件正文
        config: AI 配置
        timeout: 超时时间（秒）

    Returns:
        包含 code 和 url 的字典
    """
    base_url = config.get("base_url", "")
    api_key = config.get("api_key", "")
    model = config.get("model", "claude-sonnet-4-6")
    url = f"{base_url.rstrip('/')}/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    prompt = (
        'Extract verification code and activation URL from this email. '
        'Only return a code when the email clearly presents it as a verification/login/security code. '
        'Never return phone numbers, zip codes, prices, dates, discounts, or repeated dummy values like 000000. '
        'Return JSON: {"code": null|string, "url": null|string}.\n\n'
        f"Subject: {subject}\n\n{body_text}"
    )
    payload = {
        "model": model,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}],
    }
    response = httpx.post(url, json=payload, headers=headers, timeout=timeout)
    response.raise_for_status()
    data = response.json()
    content = data.get("content", [{}])[0].get("text", "{}")
    result = json.loads(content)
    return {"code": result.get("code"), "url": result.get("url")}


def _is_retryable_error(exc: Exception) -> bool:
    """
    判断 AI 请求错误是否适合重试。

    Args:
        exc: 捕获到的异常对象

    Returns:
        适合重试返回 True，否则返回 False
    """
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in RETRYABLE_STATUS_CODES
    return False


def _get_retry_delay_seconds(attempt: int) -> float:
    """
    计算当前重试轮次的退避等待时间。

    Args:
        attempt: 从 0 开始的失败次数

    Returns:
        当前轮次需要等待的秒数
    """
    return min(2 ** attempt, 8)
