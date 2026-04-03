# syntax=docker/dockerfile:1

# 使用精简版 Python 运行时镜像。
FROM python:3.12-slim

# 关闭 pyc 并关闭 stdout 缓冲，方便容器日志输出。
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# 设置应用工作目录。
WORKDIR /app

# 先复制依赖清单，利用 Docker 构建缓存。
COPY requirements.txt ./requirements.txt

# 安装 Python 依赖。
RUN pip install --no-cache-dir -r requirements.txt

# 创建非 root 用户，降低容器运行权限。
RUN useradd --create-home --shell /usr/sbin/nologin appuser

# 复制项目源码到镜像。
COPY . .

# 创建附件目录并授权给应用用户。
RUN mkdir -p /app/attachments && chown -R appuser:appuser /app

# 切换为非 root 用户运行应用。
USER appuser

# 暴露 FastAPI 服务端口。
EXPOSE 8000

# 启动 FastAPI 服务。
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
