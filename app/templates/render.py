from __future__ import annotations

from pathlib import Path


TEMPLATES_DIR = Path(__file__).resolve().parent


def _read_template(name: str) -> str:
    """读取模板目录中的静态文件内容。"""
    return (TEMPLATES_DIR / name).read_text(encoding="utf-8")


def _build_asset_markup(
    styles: tuple[str, ...] = (), scripts: tuple[str, ...] = ()
) -> tuple[str, str]:
    """生成页面资源标签。

    Args:
        styles: 需要插入的样式文件名列表。
        scripts: 需要插入的脚本文件名列表。

    Returns:
        tuple[str, str]: 可直接写回模板的样式标签与脚本标签。

    Notes:
        脚本统一使用 defer，保持文件顺序并避免阻塞首屏解析。
    """
    # 改为外链后，浏览器能复用缓存，避免每次请求都把大段资源重新内联到 HTML 中。
    style_markup = "\n".join(f'<link rel="stylesheet" href="/assets/{name}" />' for name in styles)
    script_markup = "\n".join(f'<script defer src="/assets/{name}"></script>' for name in scripts)
    return style_markup, script_markup


def _render_page(
    name: str, styles: tuple[str, ...] = (), scripts: tuple[str, ...] = ()
) -> str:
    """将模板占位符替换为静态资源标签。

    Args:
        name: HTML 模板文件名。
        styles: 页面依赖的样式文件名列表。
        scripts: 页面依赖的脚本文件名列表。

    Returns:
        str: 可直接返回给浏览器的 HTML 字符串。

    Notes:
        仅替换模板中的资源占位符，不修改页面正文结构。
    """
    html = _read_template(name)
    style_markup, script_markup = _build_asset_markup(styles=styles, scripts=scripts)
    return html.replace("<style>__STYLE__</style>", style_markup).replace(
        "<script>__SCRIPT__</script>", script_markup
    )


def render_console_page() -> str:
    """渲染控制台首页 HTML。

    Returns:
        str: 引用了控制台静态资源的首页 HTML。

    Notes:
        页面资源改为外链后，可复用浏览器缓存并减少服务端字符串拼接。
    """
    return _render_page("console.html", styles=("style.css",), scripts=("console.js",))


def render_detail_page() -> str:
    """渲染邮件详情页 HTML。

    Returns:
        str: 引用了详情页静态资源的详情 HTML。

    Notes:
        DOMPurify 与详情脚本分文件加载，避免把多个文件名误当成单个路径读取。
    """
    return _render_page(
        "detail.html",
        styles=("style.css",),
        scripts=("purify.min.js", "detail.js"),
    )


def render_docs_page() -> str:
    """渲染文档页 HTML。

    Returns:
        str: 引用了公共样式资源的文档页 HTML。

    Notes:
        文档页保留内联主题脚本，仅将公共样式改为可缓存的静态资源。
    """
    return _render_page("docs.html", styles=("style.css",))
