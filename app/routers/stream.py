from fastapi import APIRouter, Request, HTTPException
from app.cache import get_extraction
from app.proxy import proxy_stream

router = APIRouter()

@router.get("/{token}/video")
async def stream_video(token: str, request: Request):
    info = await get_extraction(request.app.state.redis, token)
    if not info:
        raise HTTPException(status_code=404, detail="token not found")
    return await proxy_stream(info['video']['url'], request.headers)

@router.get("/{token}/audio")
async def stream_audio(token: str, request: Request):
    info = await get_extraction(request.app.state.redis, token)
    if not info:
        raise HTTPException(status_code=404, detail="token not found")
    return await proxy_stream(info['audio']['url'], request.headers)
