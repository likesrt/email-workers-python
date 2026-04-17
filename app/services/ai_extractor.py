from __future__ import annotations

import json
from typing import Any

import httpx


def extract_with_ai(
    subject: str, body_text: str, config: dict[str, Any]
) -> dict[str, str | None]:
    """
    使用 AI 接口提取验证码和激活 URL。

    支持 OpenAI 和 Anthropic 兼容接口。

    Args:
        subject: 邮件主题
        body_text: 邮件正文
        config: AI 配置，包含 base_url, api_key, model, provider, timeout

    Returns:
        包含 code 和 url 的字典，失败返回 None 值
    """
    provider = config.get("provider", "openai").lower()
    timeout = config.get("timeout", 10)

    try:
        if provider == "anthropic":
            return _extract_with_anthropic(subject, body_text, config, timeout)
        else:
            return _extract_with_openai(subject, body_text, config, timeout)
    except Exception:
        return {"code": None, "url": None}


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
                "content": 'Extract verification code and activation URL from email. Return JSON: {"code": "...", "url": "..."}. If not found, set values to null.',
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
    model = config.get("model", "claude-3-sonnet-20240229")

    url = f"{base_url.rstrip('/')}/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }

    prompt = f'Extract verification code and activation URL from this email. Return JSON: {{"code": "...", "url": "..."}}. If not found, set values to null.\n\nSubject: {subject}\n\n{body_text}'

    payload = {"model": model, "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}]}

    response = httpx.post(url, json=payload, headers=headers, timeout=timeout)
    response.raise_for_status()
    data = response.json()
    content = data.get("content", [{}])[0].get("text", "{}")
    result = json.loads(content)
    return {"code": result.get("code"), "url": result.get("url")}
