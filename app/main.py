import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send


class StreamPassThroughGZipMiddleware:
    """/stream çıktısı tampon sıkıştırmayı atlar (video/ses yayını için gecikme riskini düşürür)."""

    def __init__(self, app: ASGIApp, minimum_size: int = 1024, compresslevel: int = 5) -> None:
        self.inner = app
        self.gzip_stack = GZipMiddleware(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") == "http" and str(scope.get("path") or "").startswith("/stream"):
            await self.inner(scope, receive, send)
            return
        await self.gzip_stack(scope, receive, send)


from redis.asyncio import Redis

from app.config import settings
from app.logger import setup_logging
from app.routers import api, stream, debug

setup_logging(settings.log_level)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        app.state.redis = Redis.from_url(settings.redis_url, decode_responses=True)
        await app.state.redis.ping()
        logger.info("Redis bağlantısı başarılı")
    except Exception as e:
        logger.warning(f"Redis bağlantısı kurulamadı (Sistem bellek içi cache ile devam edecek): {e}")
        app.state.redis = None
    
    yield
    
    if app.state.redis:
        await app.state.redis.aclose()

app = FastAPI(
    title="Tesla Video Bypass — TVB-TD",
    version=settings.app_version,
    lifespan=lifespan,
)

app.add_middleware(StreamPassThroughGZipMiddleware, minimum_size=1024)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Length", "Content-Range", "Content-Type"],
)

app.include_router(api.router, prefix="/api", tags=["api"])
app.include_router(stream.router, prefix="/stream", tags=["stream"])
app.include_router(debug.router, tags=["debug"])
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root():
    return FileResponse("static/index.html")
