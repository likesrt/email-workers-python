# email-workers

> [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/likesrt/email-workers-python)

一个两段式邮件收集项目：

- Cloudflare Worker 负责接收邮件并转发原始内容
- FastAPI 负责鉴权、解析 raw 邮件并写入 PostgreSQL
  
  
## 快速跳转

- [email-workers](#email-workers)
  - [快速跳转](#快速跳转)
  - [项目结构](#项目结构)
  - [当前架构](#当前架构)
  - [Worker 行为](#worker-行为)
  - [FastAPI 行为](#fastapi-行为)
  - [环境变量](#环境变量)
    - [FastAPI](#fastapi)
    - [Cloudflare Worker](#cloudflare-worker)
  - [Python 依赖](#python-依赖)
  - [本地 Conda 环境](#本地-conda-环境)
    - [1. 创建环境](#1-创建环境)
    - [2. 激活环境](#2-激活环境)
    - [3. 本地启动](#3-本地启动)
  - [启动 FastAPI](#启动-fastapi)
  - [鉴权方式](#鉴权方式)
  - [Worker 推送数据格式](#worker-推送数据格式)
  - [主要接口](#主要接口)
    - [1. 验证 Token](#1-验证-token)
    - [2. 查询邮件列表](#2-查询邮件列表)
    - [3. 查询邮件详情](#3-查询邮件详情)
    - [4. 兼容旧路径查询列表](#4-兼容旧路径查询列表)
    - [5. 兼容旧路径查询详情](#5-兼容旧路径查询详情)
    - [6. 清理历史邮件](#6-清理历史邮件)
  - [数据库存储字段](#数据库存储字段)
  - [部署说明](#部署说明)
    - [FastAPI](#fastapi-1)
    - [Cloudflare Worker](#cloudflare-worker-1)
  - [Docker 部署](#docker-部署)
    - [1. 准备环境变量](#1-准备环境变量)
    - [2. 启动服务](#2-启动服务)
    - [3. compose 内置服务说明](#3-compose-内置服务说明)
    - [4. 默认数据库配置](#4-默认数据库配置)
    - [5. 停止服务](#5-停止服务)
    - [6. Cloudflare Worker 对接 Docker 部署](#6-cloudflare-worker-对接-docker-部署)
  - [Cloudflare Workers 部署详解](#cloudflare-workers-部署详解)
    - [1. 使用 Deploy to Cloudflare 按钮](#1-使用-deploy-to-cloudflare-按钮)
    - [2. 手动通过 Dashboard / Wrangler 部署](#2-手动通过-dashboard--wrangler-部署)
    - [3. Worker 必填环境变量](#3-worker-必填环境变量)
    - [4. 部署后自检](#4-部署后自检)
  - [Cloudflare 邮件路由设置教程](#cloudflare-邮件路由设置教程)
    - [1. 开启 Email Routing](#1-开启-email-routing)
    - [2. 添加并验证目标邮箱](#2-添加并验证目标邮箱)
    - [3. 创建接收到 Worker 的路由规则](#3-创建接收到-worker-的路由规则)
    - [4. 绑定 Worker 到邮件路由](#4-绑定-worker-到邮件路由)
    - [5. 发送测试邮件](#5-发送测试邮件)
    - [6. 常见问题排查](#6-常见问题排查)
  - [GitHub Actions Docker 镜像构建](#github-actions-docker-镜像构建)
  - [调试建议](#调试建议)



## 项目结构

```text
.
├─ _worker.js                  # Cloudflare Email Worker
├─ wrangler.toml               # Wrangler 部署配置
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

## 本地 Conda 环境

项目已提供 [environment.yml](environment.yml)，可用于本地快速创建运行环境。

### 1. 创建环境

```bash
conda env create -f environment.yml
```

### 2. 激活环境

```bash
conda activate email-workers
```

### 3. 准备环境变量

```bash
cp .env.example .env
```

然后按需修改 `.env` 中的配置，例如 `DATABASE_URL`、`API_TOKEN`、`PORT`。

### 4. 本地启动

```bash
python main.py
```

如果你修改了依赖，可重新更新环境：

```bash
conda env update -f environment.yml --prune
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

项目提供了环境变量示例文件：[.env.example](.env.example)。

可先复制为本地 `.env`：

```bash
cp .env.example .env
```

如果你在 Windows PowerShell 中执行，可使用：

```powershell
Copy-Item .env.example .env
```

然后按需修改其中的关键配置：

- `DATABASE_URL`：本地直连 PostgreSQL 时使用
- `API_TOKEN`：FastAPI 与 Worker 共用鉴权 Token
- `PORT`：本地运行端口
- `ATTACHMENTS_DIR`：附件落盘目录
- `BACKEND_BASE_URL`：Cloudflare Worker 对外访问后端的 HTTPS 域名根地址

`docker-compose.yml` 默认会读取宿主机环境变量中的 `API_TOKEN`；如果你希望直接从 `.env` 加载，可先执行导出，或按你的运行方式让 Compose 读取 `.env`。

### 2. 启动服务

当前 `docker-compose.yml` 默认直接使用预构建镜像：

```bash
docker compose up -d
```

如果你想先手动本地打包再启动，可使用：

```bash
docker build -t ghcr.io/likesrt/email-workers-python:latest .
docker compose up -d
```

或者把 [docker-compose.yml](docker-compose.yml) 中注释掉的 `build:` 配置恢复后执行：

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

## Cloudflare Workers 部署详解

### 1. 使用 Deploy to Cloudflare 按钮

README 顶部已经提供官方 Deploy to Cloudflare 按钮，点击后会跳转到 Cloudflare 的一键部署页面。

适合场景：

- 想快速把当前仓库复制到自己的 Cloudflare / GitHub 流程中
- 不想先本地安装 Wrangler
- 需要先在 Cloudflare 控制台完成初始化部署

按钮使用的是 Cloudflare 官方格式：

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/likesrt/email-workers-python)
```

### 2. 手动通过 Dashboard / Wrangler 部署

如果你想手动部署 `_worker.js`，可以使用以下两种方式。

#### 方式 A：Cloudflare Dashboard

1. 登录 Cloudflare 控制台
2. 打开 `Workers & Pages`
3. 创建或导入 Worker
4. 将 [_worker.js](_worker.js) 内容粘贴到 Worker 编辑器
5. 在 Worker 设置中补充环境变量
6. 保存并部署

#### 方式 B：Wrangler CLI

项目已提供 [wrangler.toml](wrangler.toml)，可直接通过 Wrangler 部署：

```bash
npx wrangler deploy
```

部署前需先配置环境变量（以 secret 方式写入，不要明文写在 `wrangler.toml` 中）：

```bash
npx wrangler secret put BACKEND_BASE_URL
npx wrangler secret put API_TOKEN
```

### 3. Worker 必填环境变量

部署 Worker 时，至少需要配置：

- `BACKEND_BASE_URL`
- `API_TOKEN`

建议值说明：

- `BACKEND_BASE_URL`：FastAPI 的公网 HTTPS 域名根地址
- `API_TOKEN`：必须与 FastAPI 后端完全一致

正确示例：

```text
BACKEND_BASE_URL=https://mail.example.com
API_TOKEN=your-secret-token
```

错误示例：

```text
BACKEND_BASE_URL=http://localhost:8000
BACKEND_BASE_URL=http://email-workers-python:8000
BACKEND_BASE_URL=https://mail.example.com/internal/emails
```

### 4. 部署后自检

Worker 部署完成后，建议检查：

1. Worker 是否已成功发布
2. `BACKEND_BASE_URL` 是否是公网 HTTPS 根地址
3. `API_TOKEN` 是否与 FastAPI 完全一致
4. FastAPI 的 `/internal/emails` 是否可被公网访问
5. 发送测试邮件后，FastAPI 是否成功入库

## Cloudflare 邮件路由设置教程

### 1. 开启 Email Routing

官方前提是：你的域名已经托管在 Cloudflare，并启用了 Email Routing。

基本步骤：

1. 进入 Cloudflare 控制台
2. 选择你的域名
3. 打开 `Email` 或 `Email Routing`
4. 按向导启用 Email Routing
5. 根据 Cloudflare 提示完成所需 DNS 记录配置

如果控制台提示需要添加或修改 DNS 记录，应先完成这些记录后再继续。

### 2. 添加并验证目标邮箱

Cloudflare 官方说明里，Email Routing 通常要求先添加并验证目标邮箱。

步骤：

1. 在 Email Routing 中添加目标邮箱
2. Cloudflare 会发送验证邮件到该邮箱
3. 打开验证邮件并完成确认
4. 验证成功后，该邮箱即可作为转发目标或相关配置前提

### 3. 创建接收到 Worker 的路由规则

你的目标不是直接转发到普通邮箱，而是让邮件进入 Worker。

推荐流程：

1. 在 Email Routing 中添加新的路由规则
2. 匹配收件地址，例如：
   - `catch-all`
   - `support@example.com`
   - `*@example.com`
3. 动作选择投递到 Worker
4. 选择你部署好的 Worker

这样邮件到达 Cloudflare 后，会直接触发 Worker 的 `email(message, env, ctx)` 处理逻辑。

### 4. 绑定 Worker 到邮件路由

Cloudflare Worker 需要具备 Email handler，也就是当前 `_worker.js` 这类接收邮件事件的逻辑。

Cloudflare 官方 Email handler 入口形式类似：

```javascript
export default {
  async email(message, env, ctx) {
    // handle message
  },
}
```

你的 Worker 已经属于这一类用途：接收邮件事件、读取 raw 内容、再转发给 FastAPI。

因此要确认两点：

1. Email Routing 规则已经把邮件投递到这个 Worker
2. Worker 已经正确配置 `BACKEND_BASE_URL` 和 `API_TOKEN`

### 5. 发送测试邮件

完成路由后，建议做一次完整测试：

1. 从外部邮箱向你的域名地址发邮件
2. 确认 Cloudflare Worker 是否被触发
3. 确认 Worker 是否成功请求 FastAPI `/internal/emails`
4. 在 FastAPI 控制台中检查邮件是否出现
5. 如有附件，确认附件是否也被正确保存

### 6. 常见问题排查

#### 邮件没有触发 Worker

优先检查：

- 域名是否真的启用了 Email Routing
- MX / 相关 DNS 记录是否已按 Cloudflare 要求生效
- 路由规则是否命中目标收件地址
- 路由动作是否真的绑定到了目标 Worker

#### Worker 触发了，但后端未入库

优先检查：

- `BACKEND_BASE_URL` 是否填写正确
- `API_TOKEN` 是否一致
- FastAPI `/internal/emails` 是否公网可达
- FastAPI 是否能连 PostgreSQL
- FastAPI 日志中是否存在 401 / 500 / 解析异常

#### 出现 `403 error code: 1003`

这通常优先检查 `BACKEND_BASE_URL`：

- 不要填 IP
- 不要填 `localhost`
- 不要填 Docker 内部服务名
- 不要把 `/internal/emails` 路径写进去
- 必须是公网 HTTPS 域名根地址

## GitHub Actions Docker 镜像构建

项目已提供工作流文件：

- [.github/workflows/docker-image.yml](.github/workflows/docker-image.yml)

触发规则：

- `push` 到 `main`
- `pull_request`
- 手动触发 `workflow_dispatch`

行为说明：

- PR / 手动触发：仅构建 Docker 镜像，快速验证是否可打包
- `main` 分支推送：构建并推送镜像到 `ghcr.io/likesrt/email-workers-python`

镜像标签：

- `latest`
- `sha-<7位提交号>`

如果要使用 GHCR，请确保仓库允许 GitHub Actions 写入 packages。

## 调试建议

如果邮件未入库，可优先检查：

- Worker 的 `BACKEND_BASE_URL` 是否是公开 HTTPS 域名根地址
- Worker 和 FastAPI 的 `API_TOKEN` 是否一致
- FastAPI 是否能连通 PostgreSQL
- Cloudflare Email Routing 是否已绑定到该 Worker
- FastAPI 服务日志中是否有解析或写入错误
