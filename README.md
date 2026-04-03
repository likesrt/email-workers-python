# email-workers

一个两段式邮件收集项目：

- Cloudflare Worker 负责接收邮件并转发原始内容
- FastAPI 负责鉴权、解析 raw 邮件并写入 PostgreSQL

## 项目结构

```text
.
├─ _worker.js                  # Cloudflare Email Worker
├─ main.py                     # 本地启动入口
├─ app/
│  ├─ __init__.py              # FastAPI 应用入口
│  ├─ config.py                # 环境变量与常量
│  ├─ database.py              # 数据库连接与建表
│  ├─ mail_parser.py           # 邮件解析与附件提取
│  ├─ models.py                # Pydantic 模型
│  ├─ sql.py                   # SQL 常量
│  ├─ utils.py                 # 通用工具
│  ├─ routes/                  # 路由层
│  ├─ services/                # 服务层
│  └─ templates/               # HTML / JS / CSS 模板文件
├─ Dockerfile                  # 应用镜像构建文件
├─ docker-compose.yml          # 本地/单机部署编排文件
└─ requirements.txt            # Python 依赖
```

## 当前架构

```text
Cloudflare Email Routing
        │
        ▼
Cloudflare Worker (_worker.js)
        │  POST /internal/emails
        ▼
FastAPI (app package)
        │
        ▼
PostgreSQL
```

## Worker 行为

Worker 现在只做这几件事：

- 接收 Cloudflare Email 事件
- 读取原始邮件文本 `rawText`
- 携带基础信封信息 `mailFrom`、`rcptTo`、`receivedAt`
- 使用 `API_TOKEN` 调用 FastAPI 的 `/internal/emails`

不提供公开 HTTP 接口。

## FastAPI 行为

FastAPI 负责：

- 校验所有 API 路由的 `API_TOKEN`
- 解析 raw 邮件内容
- 提取 `Message-ID`、`Subject`、`Date`、头信息、发件地址
- 将邮件写入 PostgreSQL
- 提供控制台页面、列表查询、详情查询、历史清理接口

数据库表会在启动时自动初始化。

## 环境变量

### FastAPI

必须配置：

- `DATABASE_URL`：PostgreSQL 连接串
- `API_TOKEN`：统一鉴权 Token
- `PORT`：可选，默认 `8000`

示例：

```bash
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/maildb
API_TOKEN=your-secret-token
PORT=8000
```

### Cloudflare Worker

必须配置：

- `BACKEND_BASE_URL`：FastAPI 对外可访问的公开 HTTPS 域名根地址，例如 `https://api.example.com`
- `API_TOKEN`：与 FastAPI 保持一致

`BACKEND_BASE_URL` 必须注意：

- 这里只能写**公开可访问的域名根地址**
- **不要**写 IP 地址，例如 `https://1.2.3.4`
- **不要**写本地地址，例如 `http://localhost:8000`
- **不要**写 Docker 内部服务名，例如 `http://email-workers-python:8000`
- **不要**把路径写进去，例如 `https://api.example.com/internal/emails`

Worker 会自动拼接 `/internal/emails`。

## Python 依赖

```txt
fastapi>=0.122.0
uvicorn>=0.30.0
psycopg[binary]>=3.2.10
```

安装依赖：

```bash
pip install -r requirements.txt
```

## 启动 FastAPI

```bash
python main.py
```

或者：

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

如果使用 Docker，请直接看下方“Docker 部署”章节。

启动后默认地址：

- 控制台首页：`/`
- 文档页：`/docs`
- Swagger：`/openapi`
- 健康检查：`/healthz`

## 鉴权方式

除健康检查和页面访问外，所有 API 路由都使用：

```http
Authorization: Bearer API_TOKEN
```

包括内部写入接口：

- `POST /internal/emails`

## Worker 推送数据格式

Worker 发给 FastAPI 的请求体如下：

```json
{
  "mailFrom": "sender@example.com",
  "rcptTo": "receiver@example.com",
  "receivedAt": "2026-04-03T12:00:00.000Z",
  "rawText": "Raw RFC822 message text"
}
```

其中：

- `mailFrom`：信封发件人
- `rcptTo`：信封收件人
- `receivedAt`：Worker 接收时间
- `rawText`：邮件原文

## 主要接口

### 1. 验证 Token

```http
GET /api/auth/verify
```

### 2. 查询邮件列表

```http
GET /api/mails?rcptTo=&after=&before=&page=1&pageSize=20
```

参数：

- `rcptTo`：按收件邮箱筛选
- `after`：开始时间，ISO 格式
- `before`：结束时间，ISO 格式
- `page`：页码，从 1 开始
- `pageSize`：每页条数，最大 100

### 3. 查询邮件详情

```http
GET /api/mails/{mail_id}
```

### 4. 兼容旧路径查询列表

```http
GET /api/mail/{email}?after=&before=&page=1&pageSize=20
```

### 5. 兼容旧路径查询详情

```http
GET /api/mail/{email}/{mail_id}
```

### 6. 清理历史邮件

```http
POST /api/admin/cleanup-history
Content-Type: application/json
```

请求体：

```json
{
  "before": "2026-04-01T00:00:00.000Z"
}
```

不传 `before` 时，默认清理一天前的数据。

## 数据库存储字段

当前表会保存：

- `id`
- `message_id`
- `mail_from`
- `rcpt_to`
- `subject`
- `date_header`
- `received_at`
- `headers_json`
- `raw_text`
- `created_at`

并对 `(message_id, rcpt_to)` 做唯一约束，避免重复入库。

## 部署说明

### FastAPI

部署到任意可访问 PostgreSQL 的 Python 运行环境即可。

要求：

- 能访问 PostgreSQL
- 能被 Cloudflare Worker 通过公网访问到 `/internal/emails`
- 设置好 `DATABASE_URL` 和 `API_TOKEN`

### Cloudflare Worker

部署 `_worker.js` 后：

1. 配置 Cloudflare Email Routing 到该 Worker
2. 配置 Worker 环境变量：
   - `BACKEND_BASE_URL`
   - `API_TOKEN`
3. 确保 FastAPI 的 `/internal/emails` 能通过公网 HTTPS 域名访问
4. 如果 Worker 返回 `403 error code: 1003`，优先检查 `BACKEND_BASE_URL` 是否写成了 IP、本地地址、Docker 服务名或错误的路径

## Docker 部署

### 1. 准备环境变量

`docker-compose.yml` 默认会读取宿主机环境变量中的 `API_TOKEN`。

示例：

```bash
export API_TOKEN=your-secret-token
```

如果你在 Windows PowerShell 中执行，可使用：

```powershell
$env:API_TOKEN="your-secret-token"
```

### 2. 启动服务

```bash
docker compose up -d --build
```

启动后：

- FastAPI 控制台：`http://127.0.0.1:8000/`
- 文档页：`http://127.0.0.1:8000/docs`
- Swagger：`http://127.0.0.1:8000/openapi`
- PostgreSQL：`127.0.0.1:5432`

### 3. compose 内置服务说明

- `app`：FastAPI 服务，容器内监听 `8000`
- `db`：PostgreSQL 16，默认库名 `maildb`
- `postgres_data`：持久化数据库数据
- `mail_attachments`：持久化邮件附件文件

### 4. 默认数据库配置

`docker-compose.yml` 中应用默认使用：

```text
DATABASE_URL=postgresql://mail:mail@db:5432/maildb
```

对应 PostgreSQL 默认账号：

- `POSTGRES_DB=maildb`
- `POSTGRES_USER=mail`
- `POSTGRES_PASSWORD=mail`

如需修改，可直接调整 [docker-compose.yml](docker-compose.yml)。

### 5. 停止服务

```bash
docker compose down
```

如果你还想连同数据卷一起删除：

```bash
docker compose down -v
```

### 6. Cloudflare Worker 对接 Docker 部署

当 FastAPI 通过 Docker 部署后，Worker 的 `BACKEND_BASE_URL` 仍然必须填写**对外可访问的 HTTPS 域名根地址**。

例如：

```text
https://mail.example.com
```

不要填写：

- `http://localhost:8000`
- `http://db:5432`
- `http://email-workers-app:8000`
- `https://your-domain/internal/emails`

## 调试建议

如果邮件未入库，可优先检查：

- Worker 的 `BACKEND_BASE_URL` 是否是公开 HTTPS 域名根地址
- Worker 和 FastAPI 的 `API_TOKEN` 是否一致
- FastAPI 是否能连通 PostgreSQL
- Cloudflare Email Routing 是否已绑定到该 Worker
- FastAPI 服务日志中是否有解析或写入错误
