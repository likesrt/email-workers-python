from __future__ import annotations

import re
from typing import Any

from app.mail_parser import extract_mail_bodies


VERIFICATION_CONTEXT_PATTERNS = [
    r"验证码",
    r"校验码",
    r"动态码",
    r"安全码",
    r"一次性密码",
    r"verification\s+code",
    r"security\s+code",
    r"one[\s-]*time\s+(?:password|passcode|code)",
    r"passcode",
    r"login\s+code",
    r"auth(?:entication)?\s+code",
    r"\bOTP\b",
    r"\bPIN\b",
    r"\b2FA\b",
    r"\bMFA\b",
    r"(?:your|use|enter|input|paste|copy|this|the)\s+code\b",
    r"\bcode\s*(?:is|:)",
]
ACTIVATION_URL_PATTERNS = [
    r"activate",
    r"activation",
    r"verify",
    r"verification",
    r"confirm",
    r"reset",
    r"magic\s+link",
    r"登录链接",
    r"激活链接",
    r"验证链接",
    r"重置密码",
    r"确认",
]
NUMERIC_CODE_RE = re.compile(r"(?<!\d)(\d[\s\-]?){4,8}(?!\d)")
ALNUM_CODE_RE = re.compile(r"\b[A-Z0-9][A-Z0-9\s\-]{2,14}[A-Z0-9]\b")


def extract_verification_code(subject: str, raw_text: str) -> str | None:
    """
    从邮件主题和正文中识别验证码。

    仅在邮件存在明确验证码上下文时提取，避免把营销文案、地址或电话误判为验证码。

    Args:
        subject: 邮件主题
        raw_text: 邮件原始文本

    Returns:
        识别到的验证码字符串，未识别到返回 None
    """
    body_text = _extract_body_text(raw_text)
    full_text = f"{subject}\n{body_text}"
    if not _has_verification_context(full_text):
        return None
    return _find_code_near_keywords(full_text)


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
    去除 HTML 标签并保留纯文本内容。

    Args:
        html: HTML 字符串

    Returns:
        去除标签后的纯文本
    """
    return re.sub(r"<[^>]+>", " ", html)


def _has_verification_context(text: str) -> bool:
    """
    判断文本是否包含验证码语义上下文。

    Args:
        text: 待判断文本

    Returns:
        存在明确验证码上下文返回 True，否则返回 False
    """
    pattern = r"|".join(VERIFICATION_CONTEXT_PATTERNS)
    return bool(re.search(pattern, text, re.IGNORECASE))


def _find_code_near_keywords(text: str) -> str | None:
    """
    在验证码关键词附近窗口内查找验证码。

    Args:
        text: 待搜索文本

    Returns:
        识别到的验证码，未找到返回 None
    """
    pattern = r"|".join(VERIFICATION_CONTEXT_PATTERNS)
    for match in re.finditer(pattern, text, re.IGNORECASE):
        start = max(0, match.start() - 80)
        end = min(len(text), match.end() + 80)
        code = _extract_code_from_text(text[start:end])
        if code:
            return code
    return None


def _extract_code_from_text(text: str) -> str | None:
    """
    从文本片段中提取验证码候选串。

    Args:
        text: 待提取文本

    Returns:
        标准化后的验证码，未找到返回 None
    """
    for match in NUMERIC_CODE_RE.finditer(text):
        code = _normalize_code(match.group(0))
        if _is_candidate_code(code):
            return code
    for match in ALNUM_CODE_RE.finditer(text.upper()):
        code = _normalize_code(match.group(0))
        if _contains_mixed_alnum(code) and _is_candidate_code(code):
            return code
    return None


def _normalize_code(raw_code: str) -> str:
    """
    标准化验证码，移除分隔符并统一转为大写。

    Args:
        raw_code: 原始验证码字符串

    Returns:
        标准化后的验证码
    """
    return re.sub(r"[\s\-]", "", raw_code).upper()


def _contains_mixed_alnum(code: str) -> bool:
    """
    判断验证码是否同时包含字母和数字。

    Args:
        code: 验证码候选串

    Returns:
        同时包含字母和数字返回 True，否则返回 False
    """
    return any(ch.isalpha() for ch in code) and any(ch.isdigit() for ch in code)


def _is_candidate_code(code: str) -> bool:
    """
    判断候选串是否满足验证码的基本约束。

    Args:
        code: 验证码候选串

    Returns:
        满足约束返回 True，否则返回 False
    """
    if len(code) < 4 or len(code) > 8:
        return False
    if _is_year_noise(code) or _is_repeated_char_noise(code):
        return False
    return code.isdigit() or _contains_mixed_alnum(code)


def _is_year_noise(code: str) -> bool:
    """
    判断候选串是否为年份噪声。

    Args:
        code: 验证码候选串

    Returns:
        是年份噪声返回 True，否则返回 False
    """
    if len(code) != 4 or not code.isdigit():
        return False
    year = int(code)
    return 1900 <= year <= 2099


def _is_repeated_char_noise(code: str) -> bool:
    """
    判断候选串是否为重复字符噪声。

    Args:
        code: 验证码候选串

    Returns:
        所有字符都相同返回 True，否则返回 False
    """
    return len(code) >= 4 and len(set(code)) == 1


def sanitize_extraction_result(
    subject: str, raw_text: str, result: dict[str, Any]
) -> dict[str, str | None]:
    """
    校验外部提取结果，只保留邮件原文中能自证的值。

    Args:
        subject: 邮件主题
        raw_text: 邮件原始文本
        result: 外部提取结果

    Returns:
        经过校验后的 code 和 url
    """
    body_text = _extract_body_text(raw_text)
    full_text = f"{subject}\n{body_text}"
    search_text = f"{full_text}\n{raw_text}"
    return {
        "code": _sanitize_code_candidate(full_text, result.get("code")),
        "url": _sanitize_url_candidate(search_text, result.get("url")),
    }


def _sanitize_code_candidate(text: str, candidate: Any) -> str | None:
    """
    校验单个验证码候选值是否合法。

    Args:
        text: 邮件可读文本
        candidate: 外部返回的验证码候选值

    Returns:
        合法验证码或 None
    """
    code = _normalize_code(str(candidate or ""))
    if not code or not _has_verification_context(text):
        return None
    if not _is_candidate_code(code) or not _text_contains_code(text, code):
        return None
    return code


def _text_contains_code(text: str, code: str) -> bool:
    """
    判断文本中是否以原样或带分隔符形式包含该验证码。

    Args:
        text: 待检查文本
        code: 标准化后的验证码

    Returns:
        文本中包含该验证码返回 True，否则返回 False
    """
    pattern = r"(?<![A-Z0-9])" + r"[\s\-]*".join(map(re.escape, code)) + r"(?![A-Z0-9])"
    return bool(re.search(pattern, text, re.IGNORECASE))


def extract_activation_url(subject: str, raw_text: str) -> str | None:
    """
    从邮件主题、正文和原始内容中识别激活或验证链接。

    Args:
        subject: 邮件主题
        raw_text: 邮件原始文本

    Returns:
        识别到的激活 URL，未识别到返回 None
    """
    body_text = _extract_body_text(raw_text)
    search_text = f"{subject}\n{body_text}\n{raw_text}"
    return _find_url_near_keywords(search_text)


def _find_url_near_keywords(text: str) -> str | None:
    """
    在激活或验证关键词附近窗口内查找 URL。

    Args:
        text: 待搜索文本

    Returns:
        识别到的 URL，未找到返回 None
    """
    pattern = r"|".join(ACTIVATION_URL_PATTERNS)
    for match in re.finditer(pattern, text, re.IGNORECASE):
        start = max(0, match.start() - 120)
        end = min(len(text), match.end() + 200)
        url = _extract_url_from_text(text[start:end])
        if url:
            return url
    return None


def _extract_url_from_text(text: str) -> str | None:
    """
    从文本中提取 http 或 https URL。

    Args:
        text: 待提取文本

    Returns:
        提取到的 URL，未找到返回 None
    """
    pattern = r"https?://[^\s<>\"']+[^\s<>\"'.,;!?)]"
    match = re.search(pattern, text, re.IGNORECASE)
    return match.group(0) if match else None


def _sanitize_url_candidate(text: str, candidate: Any) -> str | None:
    """
    校验外部返回的激活链接是否存在于邮件原文中。

    Args:
        text: 邮件搜索文本
        candidate: 外部返回的链接候选值

    Returns:
        合法 URL 或 None
    """
    url = str(candidate or "").strip()
    if not url or url not in text:
        return None
    return url


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
