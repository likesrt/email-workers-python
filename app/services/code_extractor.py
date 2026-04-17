from __future__ import annotations

import re
from typing import Any

from app.mail_parser import extract_mail_bodies


def extract_verification_code(subject: str, raw_text: str) -> str | None:
    """
    从邮件主题和正文中识别验证码。

    优先匹配关键词上下文中的验证码，回退到全文第一个独立数字串。
    支持 4-8 位纯数字或字母数字混合，过滤年份等噪声。

    Args:
        subject: 邮件主题
        raw_text: 邮件原始文本

    Returns:
        识别到的验证码字符串（去除分隔符），未识别到返回 None
    """
    body_text = _extract_body_text(raw_text)
    full_text = f"{subject}\n{body_text}"

    code = _find_code_near_keywords(full_text)
    if code:
        return code

    return _find_first_standalone_code(full_text)


def _extract_body_text(raw_text: str) -> str:
    """
    从原始邮件中提取可读正文文本。

    优先使用 textBody，若无则从 htmlBody 去除 HTML 标签。

    Args:
        raw_text: 邮件原始文本

    Returns:
        可读正文文本
    """
    bodies = extract_mail_bodies(raw_text)
    text_body = bodies.get("textBody", "")
    if text_body:
        return text_body

    html_body = bodies.get("htmlBody", "")
    return _strip_html_tags(html_body) if html_body else ""


def _strip_html_tags(html: str) -> str:
    """
    去除 HTML 标签，保留纯文本内容。

    Args:
        html: HTML 字符串

    Returns:
        去除标签后的纯文本
    """
    return re.sub(r"<[^>]+>", " ", html)


def _find_code_near_keywords(text: str) -> str | None:
    """
    在关键词附近窗口内查找验证码。

    匹配「验证码/校验码/动态码/verification code/security code/code/OTP/PIN/一次性密码」
    附近前后 30 字符窗口内的 4-8 位数字或字母数字混合。

    Args:
        text: 待搜索文本

    Returns:
        识别到的验证码（去除分隔符），未找到返回 None
    """
    keywords = [
        r"验证码", r"校验码", r"动态码", r"一次性密码",
        r"verification\s+code", r"security\s+code", r"code",
        r"OTP", r"PIN"
    ]
    pattern = r"|".join(keywords)

    for match in re.finditer(pattern, text, re.IGNORECASE):
        start = max(0, match.start() - 30)
        end = min(len(text), match.end() + 30)
        window = text[start:end]

        code = _extract_code_from_text(window)
        if code:
            return code

    return None


def _find_first_standalone_code(text: str) -> str | None:
    """
    查找全文第一个独立出现的 4-8 位数字串。

    要求左右是非数字字符或字符串边界，过滤年份（1900-2099）。

    Args:
        text: 待搜索文本

    Returns:
        识别到的验证码（去除分隔符），未找到返回 None
    """
    pattern = r"(?<!\d)(\d[\s\-]?){4,8}(?!\d)"

    for match in re.finditer(pattern, text):
        candidate = match.group(0)
        code = _normalize_code(candidate)

        if code and not _is_year_noise(code):
            return code

    return None


def _extract_code_from_text(text: str) -> str | None:
    """
    从文本中提取验证码候选串。

    匹配 4-8 位纯数字或大写字母数字混合（支持空格/短横线分隔）。

    Args:
        text: 待提取文本

    Returns:
        标准化后的验证码，未找到返回 None
    """
    patterns = [
        r"\b([A-Z0-9][\s\-]?){4,8}\b",
        r"(?<!\d)(\d[\s\-]?){4,8}(?!\d)"
    ]

    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            code = _normalize_code(match.group(0))
            if code and len(code) >= 4 and len(code) <= 8:
                return code

    return None


def _normalize_code(raw_code: str) -> str:
    """
    标准化验证码：去除空格和短横线分隔符。

    Args:
        raw_code: 原始验证码字符串

    Returns:
        去除分隔符后的验证码
    """
    return re.sub(r"[\s\-]", "", raw_code)


def _is_year_noise(code: str) -> bool:
    """
    判断是否为年份噪声（1900-2099 的四位数字）。

    Args:
        code: 验证码候选串

    Returns:
        是年份返回 True，否则返回 False
    """
    if len(code) != 4 or not code.isdigit():
        return False

    year = int(code)
    return 1900 <= year <= 2099


def extract_activation_url(subject: str, raw_text: str) -> str | None:
    """
    从邮件主题和正文中识别激活/验证相关 URL。

    在关键词附近窗口查找 URL，优先返回包含关键词的 URL。

    Args:
        subject: 邮件主题
        raw_text: 邮件原始文本

    Returns:
        识别到的激活 URL，未识别到返回 None
    """
    body_text = _extract_body_text(raw_text)
    full_text = f"{subject}\n{body_text}"
    return _find_url_near_keywords(full_text)


def _find_url_near_keywords(text: str) -> str | None:
    """
    在关键词附近窗口内查找激活/验证 URL。

    匹配激活、验证、确认、重置等关键词附近的 http/https URL。

    Args:
        text: 待搜索文本

    Returns:
        识别到的 URL，未找到返回 None
    """
    keywords = [
        r"activate", r"activation", r"verify", r"verification",
        r"confirm", r"reset", r"magic\s+link", r"登录链接",
        r"激活链接", r"验证链接", r"重置密码", r"确认"
    ]
    pattern = r"|".join(keywords)

    for match in re.finditer(pattern, text, re.IGNORECASE):
        start = max(0, match.start() - 100)
        end = min(len(text), match.end() + 100)
        window = text[start:end]
        url = _extract_url_from_text(window)
        if url:
            return url

    return None


def _extract_url_from_text(text: str) -> str | None:
    """
    从文本中提取 http/https URL。

    Args:
        text: 待提取文本

    Returns:
        提取到的 URL，未找到返回 None
    """
    pattern = r"https?://[^\s<>\"']+[^\s<>\"'.,;!?)]"
    match = re.search(pattern, text, re.IGNORECASE)
    return match.group(0) if match else None


def extract_code_and_url(subject: str, raw_text: str) -> dict[str, str | None]:
    """
    从邮件中同时提取验证码和激活 URL。

    Args:
        subject: 邮件主题
        raw_text: 邮件原始文本

    Returns:
        包含 code 和 url 的字典
    """
    return {
        "code": extract_verification_code(subject, raw_text),
        "url": extract_activation_url(subject, raw_text),
    }
