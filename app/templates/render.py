from __future__ import annotations

from pathlib import Path


TEMPLATES_DIR = Path(__file__).resolve().parent


def _read_template(name: str) -> str:
    """读取模板目录中的静态文件内容。"""
    return (TEMPLATES_DIR / name).read_text(encoding="utf-8")


def render_console_page() -> str:
    """渲染控制台首页 HTML。"""
    html = _read_template("console.html")
    css = _read_template("style.css")
    js = _read_template("console.js")
    return html.replace("__STYLE__", css).replace("__SCRIPT__", js)


def render_detail_page() -> str:
    """渲染邮件详情页 HTML。"""
    html = _read_template("detail.html")
    css = _read_template("style.css")
    js = _read_template("detail.js")
    js = _read_template("purify.min.js")
    return html.replace("__STYLE__", css).replace("__SCRIPT__", js)


def render_docs_page() -> str:
    """渲染文档页 HTML。"""
    html = _read_template("docs.html")
    css = _read_template("style.css")
    return html.replace("__STYLE__", css)
