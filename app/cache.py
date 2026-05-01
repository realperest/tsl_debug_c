import json
import secrets
import logging
import time

logger = logging.getLogger(__name__)

# Bellek içi cache (Redis yoksa yedek olarak kullanılır)
_memory_cache = {}

async def store_extraction(redis, data: dict):
    token = secrets.token_urlsafe(16)
    
    # Redis varsa ona yaz
    if redis:
        try:
            await redis.setex(f"tok:{token}", 6 * 3600, json.dumps(data))
            return token
        except Exception as e:
            logger.warning(f"Redis yazma hatası, bellek içi cache kullanılıyor: {e}")

    # Redis yoksa veya hata verdiyse belleğe yaz
    _memory_cache[token] = {
        "data": data,
        "expires": time.time() + (6 * 3600)
    }
    return token

async def get_extraction(redis, token: str):
    # Önce Redis'ten dene
    if redis:
        try:
            raw = await redis.get(f"tok:{token}")
            if raw:
                return json.loads(raw)
        except Exception as e:
            logger.warning(f"Redis okuma hatası, bellek içi cache kontrol ediliyor: {e}")

    # Bellekten kontrol et
    entry = _memory_cache.get(token)
    if entry:
        if entry["expires"] > time.time():
            return entry["data"]
        else:
            del _memory_cache[token]
    
    return None
