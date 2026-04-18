from __future__ import annotations

import os
import re
from email import policy
from email.header import decode_header, make_header
from email.parser import Parser
from email.utils import parseaddr
from typing import Any
from uuid import uuid4

from app.config import ATTACHMENTS_DIR, MAX_SINGLE_ATTACHMENT_BYTES


def normalize_email_address(address: str) -> str:
    """标准化邮箱地址，统一转为去空格小写形式。"""
    return address.strip().lower()


def is_valid_email_address(address: str) -> bool:
    """判断邮箱地址格式是否有效。"""
    return bool(re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", address))


def parse_raw_message(raw_text: str) -> Any:
    """将原始邮件文本解析为邮件对象。"""
    return Parser(policy=policy.default).parsestr(raw_text or "")


def decode_part_bytes(value: bytes, charset: str | None) -> str:
    """按候选字符集解码邮件字节内容。"""
    for name in (charset, "utf-8", "gb18030", "latin-1"):
        if not name:
            continue
        try:
            return value.decode(name)
        except Exception:
            continue
    return value.decode("utf-8", errors="replace")


def get_message_part_content(part: Any) -> str:
    """提取并解码单个邮件分片正文。"""
    try:
        content = part.get_content()
    except Exception:
        return _decode_payload_content(part)
    return content if isinstance(content, str) else str(content or "")


def _decode_payload_content(part: Any) -> str:
    """在 get_content 失败时回退解码 payload。"""
    payload = part.get_payload(decode=True)
    if isinstance(payload, bytes):
        return decode_part_bytes(payload, part.get_content_charset())
    return payload if isinstance(payload, str) else ""


def extract_mail_bodies(raw_text: str) -> dict[str, str]:
    """从原始邮件中提取文本与 HTML 正文。"""
    import logging
    logger = logging.getLogger(__name__)

    message = parse_raw_message(raw_text)
    is_multi = message.is_multipart()
    parts = list(message.walk()) if is_multi else [message]

    logger.info(
        "邮件解析。is_multipart=%s parts_count=%d content_type=%s",
        is_multi,
        len(parts),
        message.get_content_type(),
    )

    result = _collect_mail_bodies(parts)
    logger.info(
        "邮件正文提取完成。text_length=%d html_length=%d",
        len(result.get("textBody", "")),
        len(result.get("htmlBody", "")),
    )
    return result


def _collect_mail_bodies(parts: Any) -> dict[str, str]:
    """遍历邮件分片并收集文本与 HTML 正文。"""
    html_body = ""
    text_body = ""
    for part in parts:
        if _skip_body_part(part):
            continue
        text_body, html_body = _merge_body_part(part, text_body, html_body)
    return {"textBody": text_body, "htmlBody": html_body}


def _skip_body_part(part: Any) -> bool:
    """判断邮件分片是否应跳过正文提取。"""
    return part.is_multipart() or part.get_content_disposition() == "attachment"


def _merge_body_part(part: Any, text_body: str, html_body: str) -> tuple[str, str]:
    """将单个分片内容合并到正文结果中。"""
    import logging
    logger = logging.getLogger(__name__)

    content = get_message_part_content(part).strip()
    content_type = (part.get_content_type() or "").lower()

    if content_type in ("text/plain", "text/html"):
        logger.info(
            "提取邮件分片。type=%s length=%d encoding=%s preview=%s",
            content_type,
            len(content),
            part.get("Content-Transfer-Encoding", ""),
            content[:100] if content else "<empty>",
        )

    if content_type == "text/plain" and content and not text_body:
        text_body = content
    if content_type == "text/html" and content and not html_body:
        html_body = content
    return text_body, html_body


def decode_mail_header(value: Any) -> str:
    """解码单个邮件头字段。"""
    text = str(value or "")
    if not text:
        return ""
    try:
        return str(make_header(decode_header(text))).strip()
    except Exception:
        return text.strip()


def extract_header_map(message: Any) -> dict[str, str]:
    """提取并解码全部邮件头。"""
    result: dict[str, str] = {}
    for key, value in message.items():
        result[str(key)] = decode_mail_header(value)
    return result


def extract_header_address(message: Any, name: str) -> str:
    """从指定邮件头提取邮箱地址。"""
    _, address = parseaddr(decode_mail_header(message.get(name)))
    return normalize_email_address(address) if address else ""


def extract_message_id(message: Any) -> str:
    """提取 Message-ID，不存在时生成新值。"""
    return decode_mail_header(message.get("Message-ID")) or str(uuid4())


def extract_subject(message: Any) -> str:
    """提取邮件主题。"""
    return decode_mail_header(message.get("Subject")) or "(no subject)"


def extract_date_header(message: Any) -> str:
    """提取邮件日期头。"""
    return decode_mail_header(message.get("Date"))


def _decode_attachment_filename(part: Any) -> str:
    """解码附件文件名，优先取 filename 参数，回退到 name 参数。"""
    filename = part.get_filename() or part.get_param("name") or ""
    return decode_mail_header(filename) or "attachment"


def _normalize_content_id(value: str) -> str:
    """标准化 Content-ID，去掉尖括号并转为小写。"""
    return str(value or "").strip().strip("<>").strip().lower()


def _should_store_attachment_part(part: Any) -> bool:
    """判断邮件分片是否需要作为附件或内联资源保存。"""
    if part.is_multipart():
        return False
    disposition = (part.get_content_disposition() or "").lower()
    if disposition in ("attachment", "inline"):
        return True
    return bool(part.get("Content-ID"))


def _safe_attachment_filename(raw_name: str, attachment_id: str) -> str:
    """对附件文件名做路径安全处理，防止目录穿越。"""
    base = os.path.basename(raw_name).strip() or "attachment"
    safe = re.sub(r"[^\w.\-]", "_", base)
    return f"{attachment_id}_{safe}"


def _write_attachment_file(attachment_id: str, raw_name: str, data: bytes) -> str:
    """将附件字节写入磁盘，返回相对于 ATTACHMENTS_DIR 的文件路径。"""
    filename = _safe_attachment_filename(raw_name, attachment_id)
    file_path = os.path.join(ATTACHMENTS_DIR, filename)
    with open(file_path, "wb") as f:
        f.write(data)
    return filename


def extract_and_save_attachments(mail_id: str, raw_text: str) -> list[dict[str, Any]]:
    """提取邮件附件与内联资源，写入磁盘并返回元数据列表。"""
    message = parse_raw_message(raw_text)
    results: list[dict[str, Any]] = []
    for part in message.walk():
        item = _build_attachment_item(mail_id, part)
        if item:
            results.append(item)
    return results


def _build_attachment_item(mail_id: str, part: Any) -> dict[str, Any] | None:
    """将邮件分片转换为附件元数据。"""
    if not _should_store_attachment_part(part):
        return None
    data = part.get_payload(decode=True)
    if not isinstance(data, bytes) or not data:
        return None
    if len(data) > MAX_SINGLE_ATTACHMENT_BYTES:
        return None
    attachment_id = str(uuid4())
    return _make_attachment_dict(mail_id, part, attachment_id, data)


def _make_attachment_dict(
    mail_id: str, part: Any, attachment_id: str, data: bytes
) -> dict[str, Any]:
    """构造单个附件元数据字典。"""
    raw_name = _decode_attachment_filename(part)
    filename = _write_attachment_file(attachment_id, raw_name, data)
    disposition = (part.get_content_disposition() or "inline").lower()
    return {
        "id": attachment_id,
        "mail_id": mail_id,
        "filename": raw_name,
        "content_type": part.get_content_type() or "application/octet-stream",
        "content_id": _normalize_content_id(part.get("Content-ID")),
        "disposition": disposition or "inline",
        "size_bytes": len(data),
        "file_path": filename,
    }
