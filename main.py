from __future__ import annotations

import os

import uvicorn


if __name__ == "__main__":
    # 本地开发入口，运行 FastAPI 应用。
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
