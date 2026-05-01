import logging
import httpx
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

# Uygulama ömrü boyunca tek bir istemci (connection pooling)
_client = httpx.AsyncClient(
    timeout=httpx.Timeout(300.0, connect=15.0),  # Cloudflare 100s, biz 300s
    follow_redirects=True,
    limits=httpx.Limits(max_keepalive_connections=20, max_connections=50),
)

async def proxy_stream(target_url: str, request_headers) -> StreamingResponse:
    upstream_headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',  # YouTube gzip verirse MP4Box bozulabilir
    }
    
    # Range header'ı geçir (seeking için kritik)
    range_val = request_headers.get('range') or request_headers.get('Range')
    if range_val:
        upstream_headers['Range'] = range_val

    try:
        logger.info(f"Stream başlatılıyor: {target_url[:80]}...")
        upstream_resp = await _client.send(
            _client.build_request('GET', target_url, headers=upstream_headers),
            stream=True,
        )
    except httpx.TimeoutException as e:
        logger.error(f"Upstream timeout: {e}")
        raise HTTPException(status_code=504, detail="upstream timeout")
    except httpx.HTTPError as e:
        logger.error(f"Upstream bağlantı hatası: {e}")
        raise HTTPException(status_code=502, detail="upstream failed")

    async def byte_iter():
        try:
            async for chunk in upstream_resp.aiter_bytes(chunk_size=64 * 1024):
                yield chunk
        except Exception as e:
            logger.warning(f"Stream kesildi: {e}")
        finally:
            await upstream_resp.aclose()

    response_headers = {
        'Content-Type': upstream_resp.headers.get('content-type', 'video/mp4'),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    }
    
    # Varsa içerik bilgilerini aktar
    if 'content-length' in upstream_resp.headers:
        response_headers['Content-Length'] = upstream_resp.headers['content-length']
    if 'content-range' in upstream_resp.headers:
        response_headers['Content-Range'] = upstream_resp.headers['content-range']

    return StreamingResponse(
        byte_iter(),
        status_code=upstream_resp.status_code,
        headers=response_headers,
    )
