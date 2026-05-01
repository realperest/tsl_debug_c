# HAZIRLIK RAPORU — PART 2 (Kodlar + Test + Hata Reçeteleri)

## Hazır Kod Dosyaları (Kopyala-Yapıştır)

### app/main.py
```python
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from redis.asyncio import Redis

from app.config import settings
from app.logger import setup_logging
from app.routers import api, stream, debug

setup_logging(settings.log_level)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.redis = Redis.from_url(settings.redis_url, decode_responses=True)
    try:
        await app.state.redis.ping()
        logger.info("Redis bağlantısı başarılı")
    except Exception as e:
        logger.error(f"Redis hatası: {e}")
    yield
    await app.state.redis.aclose()

app = FastAPI(
    title="Tesla Video Bypass — TVB-TD",
    version=settings.app_version,
    lifespan=lifespan,
)

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
```

### app/ytdlp_helper.py
```python
import logging
import yt_dlp

logger = logging.getLogger(__name__)

def search(query: str, limit: int = 10):
    opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
        'default_search': 'ytsearch',
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
        except Exception as e:
            logger.error(f"yt-dlp search hatası: {e}")
            return []

    return [
        {
            'video_id': e.get('id'),
            'title': e.get('title'),
            'thumbnail': e.get('thumbnail') or f"https://i.ytimg.com/vi/{e.get('id')}/hqdefault.jpg",
            'duration': e.get('duration'),
            'channel': e.get('channel') or e.get('uploader'),
        }
        for e in (info.get('entries') or [])
        if e.get('id')
    ]

def extract(video_id: str):
    url = f"https://www.youtube.com/watch?v={video_id}"
    opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'geo_bypass': True,
        'format': 'bv*[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]/b[ext=mp4][height<=720]',
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except Exception as e:
            logger.error(f"yt-dlp extract hatası ({video_id}): {e}")
            return None

    requested = info.get('requested_formats') or []
    video_fmt = next((f for f in requested if f.get('vcodec') and f['vcodec'] != 'none'), None)
    audio_fmt = next((f for f in requested if f.get('acodec') and f['acodec'] != 'none'), None)

    if not video_fmt or not audio_fmt:
        logger.warning(f"Uygun format bulunamadı: {video_id}")
        return None

    return {
        'video_id': video_id,
        'title': info.get('title'),
        'duration': info.get('duration'),
        'video': {
            'url': video_fmt['url'],
            'codec': video_fmt.get('vcodec'),
            'width': video_fmt.get('width'),
            'height': video_fmt.get('height'),
        },
        'audio': {
            'url': audio_fmt['url'],
            'codec': audio_fmt.get('acodec'),
            'sample_rate': audio_fmt.get('asr'),
            'channels': audio_fmt.get('audio_channels', 2),
        },
    }
```

### app/proxy.py
```python
import logging
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
import httpx

logger = logging.getLogger(__name__)

async def proxy_stream(target_url: str, request_headers) -> StreamingResponse:
    """YouTube → Server → Tesla. Decode YOK."""
    upstream_headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
    
    for k, v in request_headers.items():
        if k.lower() == 'range':
            upstream_headers['Range'] = v

    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))

    try:
        upstream_resp = await client.send(
            client.build_request('GET', target_url, headers=upstream_headers),
            stream=True,
        )
    except httpx.HTTPError as e:
        await client.aclose()
        logger.error(f"Upstream hatası: {e}")
        raise HTTPException(status_code=502, detail="upstream failed")

    async def byte_iter():
        try:
            async for chunk in upstream_resp.aiter_bytes(chunk_size=64 * 1024):
                yield chunk
        finally:
            await upstream_resp.aclose()
            await client.aclose()

    return StreamingResponse(
        byte_iter(),
        status_code=upstream_resp.status_code,
        headers={
            'Content-Type': upstream_resp.headers.get('content-type', 'application/octet-stream'),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            'Content-Length': upstream_resp.headers.get('content-length', ''),
            'Content-Range': upstream_resp.headers.get('content-range', ''),
        },
    )
```

### app/routers/api.py
```python
import logging
from fastapi import APIRouter, Request, HTTPException, Query
from app.config import settings
from app.cache import store_extraction
from app.ytdlp_helper import search, extract

router = APIRouter()
logger = logging.getLogger(__name__)

@router.get("/health")
async def health(request: Request):
    try:
        await request.app.state.redis.ping()
        redis_ok = True
    except:
        redis_ok = False

    return {
        "status": "ok" if redis_ok else "degraded",
        "version": settings.app_version,
        "redis": "connected" if redis_ok else "disconnected",
    }

@router.get("/search")
async def search_endpoint(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(10, ge=1, le=25),
):
    if not q.strip():
        raise HTTPException(status_code=400, detail="q boş olamaz")

    results = search(q.strip(), limit)
    logger.info(f"Arama '{q}' → {len(results)} sonuç")
    return {"query": q, "results": results}

@router.get("/extract/{video_id}")
async def extract_endpoint(video_id: str, request: Request):
    if len(video_id) != 11:
        raise HTTPException(status_code=400, detail="invalid video_id")

    info = extract(video_id)
    if not info:
        raise HTTPException(status_code=404, detail="video not found")

    token = await store_extraction(request.app.state.redis, info)
    logger.info(f"Extract {video_id} → token={token}")

    return {
        "token": token,
        "title": info.get('title'),
        "duration": info.get('duration'),
        "video": {
            "url_path": f"/stream/{token}/video",
            "codec": info['video']['codec'],
            "width": info['video']['width'],
            "height": info['video']['height'],
        },
        "audio": {
            "url_path": f"/stream/{token}/audio",
            "codec": info['audio']['codec'],
            "sample_rate": info['audio']['sample_rate'],
            "channels": info['audio']['channels'],
        },
    }
```

### app/routers/stream.py
```python
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
```

### app/routers/debug.py
```python
import logging
from datetime import datetime
from fastapi import APIRouter, WebSocket, Request, WebSocketDisconnect

router = APIRouter()

def _format_log(data: dict) -> str:
    ts = data.get('ts', datetime.utcnow().isoformat())
    level = data.get('level', 'info').upper()
    source = data.get('source', '?')
    message = data.get('message', '')
    return f"[{ts}] [{level:5s}] [{source:8s}] {message}"

@router.post("/api/log")
async def receive_log(request: Request):
    data = await request.json()
    print(_format_log(data), flush=True)
    return {"ok": True}

@router.websocket("/ws/log")
async def ws_log(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            print(_format_log(data), flush=True)
    except WebSocketDisconnect:
        pass
```

### static/js/debug.js
```javascript
const buffer = [];
let wsLog = null;

function connectWS() {
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsLog = new WebSocket(`${proto}//${location.host}/ws/log`);
    wsLog.onclose = () => {
      wsLog = null;
      setTimeout(connectWS, 3000);
    };
  } catch (e) {
    setTimeout(connectWS, 3000);
  }
}
connectWS();

export function log(level, source, message, extra) {
  const entry = {
    ts: new Date().toISOString(),
    level: level || 'info',
    source: source || 'global',
    message: typeof message === 'string' ? message : JSON.stringify(message),
    extra: extra || null,
  };
  buffer.push(entry);

  console[level || 'log'](`[${entry.source}]`, message, extra || '');

  const logEl = document.getElementById('debug-log');
  if (logEl && shouldShow(entry)) {
    const line = document.createElement('div');
    line.className = `log-line log-${entry.level} log-source-${entry.source}`;
    line.textContent = `[${entry.ts.slice(11, 23)}] [${entry.level.toUpperCase().padEnd(5)}] [${entry.source}] ${entry.message}`;
    logEl.appendChild(line);
    if (document.getElementById('auto-scroll')?.checked) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  if (document.getElementById('send-to-server')?.checked) {
    if (wsLog?.readyState === WebSocket.OPEN) {
      wsLog.send(JSON.stringify(entry));
    } else {
      fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
        keepalive: true,
      }).catch(() => {});
    }
  }
}

function shouldShow(entry) {
  const filter = document.getElementById('debug-filter')?.value || 'all';
  return filter === 'all' || filter === entry.source;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('clear-log')?.addEventListener('click', () => {
    buffer.length = 0;
    document.getElementById('debug-log').innerHTML = '';
  });
});

window.addEventListener('error', (e) => {
  log('error', 'global', `${e.message}`, { file: e.filename, line: e.lineno });
});
```

### static/js/main.js (İskelet)
```javascript
import { log } from './debug.js';
import * as Tech1 from './tech1-webcodecs-canvas2d.js';
import * as Tech2 from './tech2-webcodecs-webgl.js';
import * as Tech3 from './tech3-jmuxer-mse.js';

const modules = [Tech1, Tech2, Tech3];

function initAllModules() {
  log('info', 'global', `${modules.length} modül init ediliyor`);
  modules.forEach(m => {
    const mod = m.TechModule;
    const panel = document.getElementById(`panel-${mod.id}`);
    try {
      mod.init(panel);
      log('info', mod.id, `${mod.name} hazır`);
    } catch (e) {
      log('error', mod.id, `Init hatası: ${e.message}`);
    }
  });
}

async function performSearch(query) {
  log('info', 'global', `Arama: "${query}"`);
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=10`);
    const data = await r.json();
    const container = document.getElementById('search-results');
    container.innerHTML = data.results.map(r => `
      <div class="search-result-card" onclick="loadVideo('${r.video_id}')">
        <img src="${r.thumbnail}" alt="${r.title}">
        <div class="title">${r.title}</div>
      </div>
    `).join('');
  } catch (e) {
    log('error', 'global', `Arama hatası: ${e.message}`);
  }
}

async function loadVideo(videoId) {
  log('info', 'global', `Video seçildi: ${videoId}`);
  try {
    const r = await fetch(`/api/extract/${videoId}`);
    const data = await r.json();
    log('info', 'global', `Token: ${data.token}`);
    
    await Promise.allSettled(
      modules.map(m => m.TechModule.load(data.token, data).catch(e => 
        log('error', m.TechModule.id, `Load hatası: ${e.message}`)
      ))
    );
  } catch (e) {
    log('error', 'global', `Yükleme hatası: ${e.message}`);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initAllModules();
  document.getElementById('search-btn').addEventListener('click', () => {
    const q = document.getElementById('search-input').value.trim();
    if (q) performSearch(q);
  });
  log('info', 'global', 'Sayfa hazır');
  log('info', 'global', `WebCodecs: ${'VideoDecoder' in window ? 'var ✅' : 'yok ❌'}`);
});

window.loadVideo = loadVideo;
```

### docker-compose.yml
```yaml
version: '3.9'
services:
  app:
    build: .
    ports:
      - "8000:8000"
    environment:
      - REDIS_URL=redis://redis:6379/0
      - LOG_LEVEL=INFO
      - APP_VERSION=260429.0002
    depends_on:
      - redis
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

### requirements.txt
```txt
fastapi==0.115.0
uvicorn[standard]==0.30.6
yt-dlp>=2025.1.15
httpx==0.27.2
redis==5.0.8
pydantic==2.9.2
pydantic-settings==2.5.2
python-dotenv==1.0.1
websockets==13.0.1
aiofiles==24.1.0
```

---

## Test Senaryoları (PC ve Tesla)

### PC Smoke Test
```bash
./scripts/test-curl.sh
```

**Kontrol listesi:**
- [ ] `/api/health` 200 döner
- [ ] `/api/search?q=tesla` 5+ sonuç
- [ ] `/api/extract/{vid}` token üretir
- [ ] `/stream/{token}/video` 206 Partial Content (Range ile)

### Frontend Test (PC Chrome)
1. `http://localhost:8000` aç
2. "tesla" ara
3. Bir video seç
4. 5 panel paralel yüklenmeye başlamalı
5. Debug panelinde log akmalı
6. Hangi paneller video oynatıyor?
7. Hangileri ses veriyor?

### Tesla Park Testi
1. `https://tesla-test.kullaniciyorumlari.com` aç
2. Debug panelinde `WebCodecs: var mı?`
3. Video yükle, 5 paneli gözle
4. Park'ta çalışan panel'leri not et

### Tesla Hareket Testi (KRİTİK)
1. Güvenli sürüş: yardımcı sürücü yanında
2. 10-20 km/saat hareket
3. 5 paneli gözle:
   - Görüntü var mı?
   - Ses var mı?
   - FPS düştü mü?
4. Telefonda not et
5. `docs/TEST_NOTLARI.md`'yi doldur

---

## Hata Reçeteleri

### "yt-dlp: Unable to extract video data"
**Sebep:** YouTube format'ı değişti, yt-dlp güncel değil.
**Çözüm:** `docker exec -it tesla-bypass-app pip install -U yt-dlp`

### 502 Bad Gateway (proxy'de)
**Sebep:** YouTube URL süresi geçti veya CDN hata veriyor.
**Çözüm:** Frontend `/api/extract` yeniden çağırır, yeni token oluştur.

### Redis connection refused
**Sebep:** Redis container ayakta değil.
**Çözüm:** `docker logs tesla-bypass-redis` kontrol et

### "VideoDecoder is not defined"
**Sebep:** Tesla'da WebCodecs kapalı.
**Çözüm:** Bu test için beklenen durum. Diğer panelleri test et.

### CORS error
**Sebep:** Backend CORS başlıkları yok.
**Çözüm:** `app/main.py`'deki CORSMiddleware kontrol et

### "jmuxer MSE error" + Tesla harekette video yok
**Sebep:** Beklenen davranış (Tek 3 kontrol grubu).
**Sonuç:** Tesla `<video>` engelle,  hipotez doğru.

### Sayfa Tesla'da açılmıyor
**Sebep:** HTTPS sertifikası invalid veya süresi geçti.
**Çözüm:** Coolify'da Let's Encrypt sertifikasını yenile

### 5 panelin hepsi siyah (park'ta bile)
**Sebep:** Tesla browser çok eski, modern API yok.
**Çözüm:** Tesla yazılım güncellemesi gerekli

---

## Kabul Kriterleri (DoD)

### Backend
- [ ] `docker-compose up` başarılı
- [ ] `/api/health` redis connected döner
- [ ] `/api/search` 5+ sonuç
- [ ] `/api/extract` token + URLs
- [ ] `/stream/{token}/video` Range destekli
- [ ] 1080p akarken CPU < %5
- [ ] CORS başlıkları var
- [ ] `POST /api/log` Coolify'da görünür
- [ ] `/ws/log` reconnect ediyor

### Frontend (PC)
- [ ] 5 panel grid açılıyor
- [ ] Arama çalışıyor
- [ ] Video seçilince 5 panel paralel yükleniyor
- [ ] Debug paneli renk kodlu log gösteriyor
- [ ] PC Chrome'da 3+ panel video + ses geçiriyor
- [ ] FPS > 25
- [ ] Hata loglanıyor

### Tesla
- [ ] Park'ta sayfa açılıyor, HTTPS uyarısı yok
- [ ] Hangi panel'ler görüntü veriyor? (not et)
- [ ] Hangileri ses veriyor? (not et)
- [ ] Coolify log'ları indirilip kaydedildi
- [ ] TEST_NOTLARI.md dolduruldu

---

## AI Ajan İçin Doğrudan Talimatlar

1. **Bu raporu 2 kez oku.** İlk okumada genel resim, ikincisinde teknik.
2. **Bölüm 9 (klasör yapısı) harfiyen uygula.**
3. **Bölüm hazır kodlarını doğrudan kullan**, gereksiz değiştirme.
4. **5 teknolojiler Tek 1 → Tek 5 → Tek 2 → Tek 3 → Tek 4 sırasında yaz.**
5. **Her teknoloji bittiğinde git commit at (Türkçe):**
   ```bash
   git commit -m "feat: Tek 1 (WebCodecs+Canvas2D) tamamlandı, PC test geçti"
   ```
6. **Coolify log'una çıktı basılacak kodu ekle:**
   ```
   [milestone] Tek X tamamlandı
   ```
7. **Hata varsa Bölüm "Hata Reçeteleri"'ne bak, sonra çöz.**
8. **Kırmızı çizgileri sakın ihlal etme:**
   - ❌ Server-side video decode YASAK
   - ❌ Sessiz fail YASAK
   - ❌ CDN kütüphaneler YASAK

9. **Bittiğinde raporla:**
   ```
   ✅ Backend hazır
   ✅ Tek 1,2,5 PC'de çalışıyor
   ⚠️ Tek 4 yavaş
   🚀 Coolify deploy hazır
   ```

---

**RAPOR SONU — PART 2**

Tüm kod hazır, test senaryoları ve hata reçeteleri bu dosyada. AI ajan Cursor'a Part 1 + Part 2'yi @at yapıp "Kur ve geliştir" diyebilir.
