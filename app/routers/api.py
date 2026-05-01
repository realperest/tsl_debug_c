import logging
from fastapi import APIRouter, Request, HTTPException, Query
from app.config import settings
from app.cache import store_extraction
from app.ytdlp_helper import search, extract, get_trending

router = APIRouter()
logger = logging.getLogger(__name__)

@router.get("/trending")
async def trending_endpoint(limit: int = Query(24, ge=1, le=50)):
    results = get_trending(limit)
    return {"results": results}

@router.get("/search")
async def search_endpoint(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(24, ge=1, le=50),
):
    results = search(q.strip(), limit)
    return {"query": q, "results": results}

@router.get("/extract/{video_id}")
async def extract_endpoint(video_id: str, request: Request):
    info = extract(video_id)
    if not info:
        raise HTTPException(status_code=404, detail="video not found")
    token = await store_extraction(request.app.state.redis, info)
    vu = info["video"].get("url") or ""
    au = info.get("audio") and info["audio"].get("url") or ""
    unified = bool(vu and au and vu == au)
    return {
        "token": token,
        "title": info.get('title'),
        "unified_av_stream": unified,
        "video": {"url_path": f"/stream/{token}/video", "codec": info['video']['codec']},
        "audio": {"url_path": f"/stream/{token}/audio", "codec": info['audio']['codec']}
    }
