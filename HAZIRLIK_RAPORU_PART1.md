# HAZIRLIK RAPORU — Tesla Hareket Halinde Video Oynatma — Teknoloji Doğrulama (TVB-TD)

> **Bu doküman bir AI kodlama ajanı (Claude Code, Cursor) için tek kaynaklı brifing dosyasıdır.**
>
> **Versiyon:** 260429.0002  
> **Hazırlayan:** Claude (Anthropic) — Alper'in araştırma direktifiyle

---

## İÇİNDEKİLER

0. [TL;DR ve Hızlı Başlangıç](#0-tldr-ve-hızlı-başlangıç)
1. [Proje Bağlamı ve Problem Tanımı](#1-proje-bağlamı-ve-problem-tanımı)
2. [Saha Araştırması ve Hipotez](#2-saha-araştırması-ve-hipotez)
3. [Mimari ve Veri Akışları](#3-mimari-ve-veri-akışları)
4. [Sözlük: Türkçe-İngilizce Teknik Terimler](#4-sözlük)
5. [5 Test Teknolojisi — Detaylı Spesifikasyon](#5-5-test-teknolojisi)
6. [Backend — FastAPI + yt-dlp + Reverse Proxy](#6-backend)
7. [Frontend — Tek Sayfa, 5 Panel](#7-frontend)
8. [Debug ve Logging Sistemi](#8-debug)
9. [Klasör Yapısı ve Hazır Dosyalar](#9-klasör-yapısı)
10. [Geliştirme Adımları (Sıralı)](#10-geliştirme-adımları)

---

## 0. TL;DR ve Hızlı Başlangıç

### Tek Cümlede Proje
Tesla aracın merkez ekranındaki web tarayıcısı, araç **hareket halindeyken HTML5 `<video>` etiketini engeller**. Bu projede, **`<video>` etiketi kullanmayan 5 farklı tekniği aynı sayfada paralel test ederek**, hangisinin Tesla'nın engellemesini bypass ettiğini doğrulayacağız.

**KIRMIZI ÇİZGİ:** Sunucu **HİÇBİR koşulda** video decode/transcode YAPMAYACAK. Sadece yt-dlp (URL çıkarma) + reverse proxy (byte forwarding).

### 5 Test Teknolojisi

| # | İsim | `<video>` kullanır mı? | Beklenen başarı |
|---|---|---|---|
| 1 | WebCodecs + Canvas 2D | ❌ Hayır | 80% |
| 2 | WebCodecs + WebGL | ❌ Hayır | 80% |
| 3 | jmuxer + MSE | ✅ **Evet** (KONTROL GRUBU) | 20% |
| 4 | ffmpeg.wasm + Canvas | ❌ Hayır | 50% |
| 5 | WebCodecs → JPEG → `<img>` | ❌ Hayır | 85% |

**Tek 3 bilinçli kontrol grubudur** — çalışmazsa hipotez doğru, çalışırsa yanlış.

### İlk 5 Komut

```bash
git clone <repo> && cd tesla-bypass
docker-compose up --build
# Başka terminal:
./scripts/test-curl.sh
# Tarayıcıda: http://localhost:8000
```

---

## 1. Proje Bağlamı ve Problem Tanımı

### 1.1 Senaryo

Alper'in Tesla aracı var. Park'ta YouTube videoları sorunsuz oynar. **Hareket ettiğinde:**
- Video görüntüsü **siyaha döner** / donmuş kalır
- Bazı durumlarda ses kesilir
- Bu davranış tüm `<video>` etiketi kullanan sayfalar için tutarlı

Bu, Tesla'nın yasal uyumluluk için (NHTSA + global regülasyonlar) eklediği bilinçli bir kısıtlamadır.

### 1.2 Önceki Başarısız Denemeler

1. **Sunucuda video decode + Canvas** → Çalıştı, ama maliyetli
2. **Cloud browser** → Çalıştı, ama pahalı
3. **Tesla'da direkt `<video>`** → Park'ta çalıştı, harekette siyahlaştı

### 1.3 KIRMIZI ÇİZGİ

```
❌ Sunucu video transcode/decode YAPMAYACAK
✅ yt-dlp (URL çıkarma) SERBEST
✅ HTTP reverse proxy SERBEST  
✅ Redis token cache SERBEST
```

### 1.4 Başarı Tanımı

Bu proje şu soruları KESIN cevaplarsa başarılıdır:
1. Tesla'da WebCodecs var mı?
2. Hareket halinde hangiler görüntü veriyor?
3. Hangiler ses veriyor?
4. Tesla'nın engelleme detektörünün dokunduğu seviye nedir?

---

## 2. Saha Araştırması ve Hipotez

### 2.1 Bilinen Saha Kanıtları

#### Kanıt #1 — Blue Iris + Tesla
- **Kaynak:** https://teslamotorsclub.com/tmc/threads/playing-audio-video-while-driving.280471/
- **Bulgu:** Park'ta IP kamera akışı gözüküyor. D modunda durmuyor. "JavaScript player" moduna geçince çalışıyor.
- **Çıkarım:** Tesla `<video>` elementini tespit ediyor.

#### Kanıt #2 — TeslaStream (2018)
- **Kaynak:** https://teslamotorsclub.com/tmc/threads/teslastream-add-video-display-mirroring-support-to-your-tesla-browser.107103/
- **Bulgu:** Geliştirici "They purposely disabled html5 video + audio element" demiş. "Compressed photos" (JPEG stream) yöntemiyle çözmüş.
- **Çıkarım:** 2018'de çözüm "video etiketinden kaçınmak" idi.

#### Kanıt #3 — marcraft2/tesla-carplay (2022)
- **Kaynak:** https://github.com/marcraft2/tesla-carplay
- **Bulgu:** jmuxer kullanıyor (MSE + `<video>`). Ama ses "browser does not allow sound while driving" diye Bluetooth'a yönlendirilmiş.
- **Çelişki:** jmuxer `<video>` kullanır. Görüntü çalışıyorsa MSE bypass yolu var mı?

#### Kanıt #4 — FSD Theater
- **Bulgu:** "low level browser APIs" ile çözmüş, detay vermemiş.
- **İpucu:** Muhtemelen WebCodecs veya WASM.

### 2.2 Hipotez

> **H1 (Ana):** Tesla'nın detektörü, DOM ağacında `HTMLVideoElement` instance'larını ve/veya `MediaSource` pipeline'larını tarar. Canvas'a drawImage ile çizilen pikseller tespit edilmez.
>
> **H2 (Test gerekli):** MSE de engellenir mi? (Tek 3 test eder)
>
> **H3:** Canvas üzerine render edilen pikseller "video" olarak algılanmaz.

---

## 3. Mimari ve Veri Akışları

### 3.1 Sistem Diyagramı

```
┌─────────────────────────────────────────────────────┐
│ KAYA VDS — Docker Compose + Coolify                 │
│                                                      │
│  FastAPI (8000) ◄──► Redis (6379)                   │
│  - /api/search                                      │
│  - /api/extract/{vid}                               │
│  - /stream/{token}/* (reverse proxy)                │
│  - /api/log, /ws/log                                │
│                                                      │
│  Static: index.html, 5 tech*.js, lib/*              │
└────────────────┬──────────────────────┬─────────────┘
                 │                      │
             HTTPS                   HTTPS
                 │                      │
                 ▼                      ▼
         Tesla Browser          YouTube CDN
         (Chromium 109)         (googlevideo.com)
         
         5 panel grid
         + debug log
```

### 3.2 Tek Test Akışı

```
1. Kullanıcı "tesla" ara → /api/search
2. Backend: yt-dlp arama → sonuçlar JSON
3. Kullanıcı video seç → /api/extract/{video_id}
4. Backend: yt-dlp URL'ler çıkar → Redis token
5. Frontend: 5 panele token dağıt
6. Her panel paralel decode:
   - /stream/{token}/video (MP4 H.264)
   - /stream/{token}/audio (m4a AAC)
7. Backend: YouTube CDN'e pass-through (decode YOK)
8. Tarayıcıda: Her panel kendi yöntemiyle decode
9. Debug log: WebSocket/POST → Coolify stdout
```

---

## 4. Sözlük: Türkçe-İngilizce Teknik Terimler

| Türkçe | İngilizce | Açıklama |
|---|---|---|
| Teknoloji # / Tek # | Technology # | 5 test yöntemi (Tek 1, Tek 2, ...) |
| Panel | Panel | Sayfada her teknoloji için kutu |
| Decoder | Decoder | Sıkıştırılmış → ham frame |
| Demuxer | Demultiplexer | MP4 → track'lere ayıran |
| Reverse proxy | Reverse proxy | Byte-level yönlendirme |
| Token | Token | Kısa random string, Redis'te URL temsil eder |
| TTL | Time To Live | Cache geçerlilik süresi |
| Frame | Frame | Videonun tek karesi |
| Codec | Codec | Sıkıştırma (H.264, VP9 vb.) |
| MSE | Media Source Extensions | JS'den `<video>`'ya medya beslemek |
| WebCodecs | WebCodecs API | Düşük seviyeli encode/decode |
| Hardware decode | Donanım decode | GPU → hızlı |
| Software decode | Yazılım decode | CPU → yavaş |

---

## 5. 5 Test Teknolojisi — Detaylı Spesifikasyon

### 5.1 Tek 1: WebCodecs + Canvas 2D

**Amaç:** `<video>` olmadan VideoDecoder + AudioDecoder ile decode, Canvas 2D'ye çizme.

**Veri Akışı:**
```
/stream/{token}/video (MP4 H.264)
  ↓ (mediabunny UrlSource — prefetch + range request)
mediabunny.Input (demuxer)
  ↓
VideoDecoder (hardware) → VideoFrame
  ↓
ctx.drawImage(frame, 0, 0)
```

**Bağımlılıklar:** `mediabunny@^2.0.0`

**Beklenen:** 720p'de 30 FPS, CPU %10

**Risk:** Tesla'da WebCodecs kapalı olabilir

**Kontrol:** `if (!('VideoDecoder' in window)) log('error', ...)`

### 5.2 Tek 2: WebCodecs + WebGL

**Amaç:** Aynı decode, ama WebGL texture'a yükle.

**Veri Akışı:** Tek 1 + `gl.texImage2D()` + fragment shader

**Avantaj:** Daha az CPU

**Risk:** GPU context loss (Tesla yenilenebilir), texture allocation

**Beklenen:** Tek 1'den %10-20 daha hızlı

### 5.3 Tek 3: jmuxer + MSE (KONTROL GRUBU)

**Amaç:** `<video>` etiketi KULLANarak test. Çalışmazsa H1 doğru, çalışırsa yanlış.

**Kod:**
```javascript
jmuxer.feed({ video: h264_buffer, audio: aac_buffer, duration: chunk_ms });
// → MSE → <video>
```

**Bağımlılıklar:** `jmuxer@^2.0.2`, `mp4box.js`

**Beklenen:** PC'de çalışır, Tesla harekette siyahlaşır (hipotez doğru demek)

**Kontrol grubu mantığı:** Eğer çalışırsa, Tesla detektörü "tüm `<video>`" değil de "origin/codec pattern" bakıyor demektir.

### 5.4 Tek 4: ffmpeg.wasm + Canvas

**Amaç:** WebCodecs kapalıysa fallback. Yazılım decode.

**Veri Akışı:**
```
/stream/{token}/video
  ↓ (ffmpeg.wasm)
Software H.264 decode
  ↓ (WASM CPU'da)
ImageData → Canvas
```

**Bağımlılıklar:** `@ffmpeg/ffmpeg@0.12` (~30MB)

**Beklenen:** Yavaş (5-15 FPS), ama uyumlu

**Risk:** WASM yükleme, CPU yüksek

### 5.5 Tek 5: WebCodecs → JPEG → `<img>`

**Amaç:** Paranoid varyant. Decode + client-side JPEG encode + `<img>`.

**Akış:**
```
WebCodecs decode (Tek 1)
  ↓
offscreenCanvas.convertToBlob('image/jpeg')
  ↓
<img src=blob://...>
```

**Risk:** Çift encode (decode + JPEG encode), memory

**Beklenen:** En güvenli, 30 FPS civarı

---

## 6. Backend — FastAPI + yt-dlp + Reverse Proxy

### 6.1 Amaç

- YouTube arama (yt-dlp)
- Format URL'lerini çıkarma (yt-dlp)
- Reverse proxy (HTTP byte forwarding, DECODE YOK)
- Log alıcı (frontend → Coolify)

### 6.2 yt-dlp Format Seçimi

```python
format = 'bv*[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]/best[ext=mp4][height<=720]'
# En kaliteli H.264 (avc1) video-only 720p'ye kadar
# + En kaliteli AAC audio-only
```

**Neden?** Tesla için H.264 + AAC en uyumlu. 720p güvenli başlangıç.

### 6.3 Reverse Proxy Detayı

```python
async def proxy_stream(target_url: str, request_headers):
    """
    YouTube URL'e GET at, byte'larını Tesla'ya ilet.
    DECODE YOK. Range header pass-through.
    """
    upstream_headers = {'User-Agent': 'Mozilla/5.0 ...'}
    # Range header'ı pass-through
    if 'range' in request_headers.keys():
        upstream_headers['Range'] = request_headers['range']
    
    async with httpx.AsyncClient() as client:
        upstream = await client.stream('GET', target_url, headers=upstream_headers)
        return StreamingResponse(
            upstream.aiter_bytes(chunk_size=64*1024),
            headers={
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*',
            }
        )
```

**CPU kullanımı:** <%1 (sadece TCP buffer copy)

### 6.4 Redis Token Yönetimi

```python
async def store_extraction(redis, data):
    token = secrets.token_urlsafe(16)
    await redis.setex(f"tok:{token}", 6*3600, json.dumps(data))
    # TTL = 6 saat (YouTube URL'ler ortalama bu kadar yaşar)
    return token

async def get_extraction(redis, token):
    raw = await redis.get(f"tok:{token}")
    return json.loads(raw) if raw else None
```

### 6.5 Endpoint'ler

| Method | Path | Amaç |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/search?q=...&limit=10` | YouTube arama |
| GET | `/api/extract/{video_id}` | URL'leri çıkar, token oluştur |
| GET | `/stream/{token}/video` | Reverse proxy MP4 |
| GET | `/stream/{token}/audio` | Reverse proxy AAC |
| POST | `/api/log` | Frontend log alıcı |
| WS | `/ws/log` | Frontend log WebSocket |

---

## 7. Frontend — Tek Sayfa, 5 Panel

### 7.1 HTML Yapısı

```html
<header>
  <h1>Tesla Video Test Lab</h1>
  <input placeholder="YouTube'da ara..." />
  <div id="search-results"><!-- sonuç card'ları --></div>
</header>

<main id="panels">
  <section class="panel" id="panel-tech1">
    <h3>#1 — WebCodecs + Canvas 2D</h3>
    <div class="status-bar">
      <span class="led" data-led="load"></span>
      <span class="led" data-led="decode"></span>
      <span class="led" data-led="render"></span>
      <span class="stats">FPS: -- | Frame: -- | Drop: --</span>
    </div>
    <canvas></canvas>
    <div class="controls">
      <button data-action="reset">↻ Yeniden başlat</button>
      <button data-action="snapshot">📸 Snapshot</button>
    </div>
  </section>
  <!-- Tek 2, 3, 4, 5 benzer... -->
</main>

<section id="debug-panel">
  <div class="debug-header">
    <strong>🐞 Debug</strong>
    <select id="debug-filter"><!-- Tüm / Tek 1 / ... / ERROR sadece --></select>
    <button id="clear-log">🗑</button>
    <button id="copy-log">📋</button>
  </div>
  <div id="debug-log"></div>
</section>
```

### 7.2 Status LED'leri

Her panelde 3 LED:
- 🔴 Hata / 🟡 Yükleniyor / 🟢 Tamam / ⚪ Beklemede

### 7.3 Modül Sözleşmesi

```javascript
export const TechModule = {
  id: 'tech1',
  name: 'WebCodecs + Canvas 2D',
  init(panelEl) { /* modülü hazırla */ },
  async load(token, metadata) { /* video yükle */ },
  reset() { /* temizle */ },
  getStats() { /* {fps, frameCount, dropCount, lastError} */ },
};
```

### 7.4 YAPILMAYACAKLAR

- ❌ Framework (React, Vue)
- ❌ TypeScript
- ❌ Tailwind/CSS framework
- ❌ CDN dependency (her şey lokal)
- ❌ Service Worker

---

## 8. Debug ve Logging Sistemi

### 8.1 Frontend Debug Paneli

```javascript
import { log } from './debug.js';

log('info', 'tech1', 'WebCodecs configured', { codec: 'avc1.640028', width: 1280 });
log('error', 'tech3', 'jmuxer error', { error: e.message });
log('debug', 'tech1', `FPS: ${fps.toFixed(1)}`);
```

**Renkler:**
- 🔵 INFO — mavi
- 🟠 WARN — turuncu
- 🔴 ERROR — kırmızı (bold)

**Filtreleme:** Tüm / Tek 1-5 / SERVER / ERROR sadece

**Backend:** `/api/log` (POST) veya `/ws/log` (WebSocket) → Coolify stdout

### 8.2 Loglanacak Olaylar (Zorunlu)

**INFO:**
- Modül yüklendi
- Decoder configured
- İlk frame decoded (ms cinsinden)
- Stream tamamlandı

**DEBUG:**
- Her saniye FPS
- Queue size
- Network fetch süresi

**WARN:**
- Frame drop
- Codec uyumsuzluğu
- Memory pressure

**ERROR:**
- API not supported
- Decoder error
- Fetch failure
- WebSocket disconnect

---

## 9. Klasör Yapısı ve Hazır Dosyalar

```
tesla-bypass/
├── README.md
├── HAZIRLIK_RAPORU.md
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
├── .env.example
├── .gitignore
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── config.py
│   ├── logger.py
│   ├── cache.py
│   ├── ytdlp_helper.py
│   ├── proxy.py
│   └── routers/
│       ├── api.py
│       ├── stream.py
│       └── debug.py
├── static/
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── main.js
│   │   ├── debug.js
│   │   ├── tech1-webcodecs-canvas2d.js
│   │   ├── tech2-webcodecs-webgl.js
│   │   ├── tech3-jmuxer-mse.js
│   │   ├── tech4-wasm-ffmpeg.js
│   │   ├── tech5-webcodecs-mjpeg-img.js
│   │   └── lib/
│   │       ├── mediabunny.min.js
│   │       ├── mp4box.all.min.js
│   │       ├── jmuxer.min.js
│   │       └── ffmpeg/ (ffmpeg.wasm, ffmpeg-core.js vb.)
│   └── assets/
├── scripts/
│   ├── download-libs.sh
│   └── test-curl.sh
└── docs/
    ├── TEST_NOTLARI.md
    └── TROUBLESHOOTING.md
```

---

## 10. Geliştirme Adımları (Sıralı)

### Adım 1: Klasör Yapısı (15 dk)
```bash
mkdir tesla-bypass && cd tesla-bypass
mkdir -p app/routers static/css static/js/lib/ffmpeg static/assets scripts docs
git init
```

### Adım 2: Hazır Dosyaları Yapıştır (30 dk)
- requirements.txt, Dockerfile, docker-compose.yml
- app/*.py dosyaları
- static/index.html, css/style.css
- static/js/debug.js, main.js, tech*.js

### Adım 3: Frontend Kütüphanelerini İndir (5 dk)
```bash
./scripts/download-libs.sh
```

### Adım 4: Lokalde Test (15 dk)
```bash
docker-compose up --build
./scripts/test-curl.sh
# http://localhost:8000 test et
```

### Adım 5: 5 Teknolojiyi Yaz (1.5-2 gün)
**Sıra:** Tek 1 → Tek 5 → Tek 2 → Tek 3 → Tek 4

Her biti sonunda git commit (Türkçe mesaj):
```bash
git commit -m "feat: Tek 1 (WebCodecs+Canvas2D) tamamlandı, PC test geçti"
```

### Adım 6: Coolify Deploy (30 dk)
Coolify panelinde Docker Compose projesi oluştur.

### Adım 7: Tesla Test (30 dk)
Park + Hareket senaryoları. Resultları `docs/TEST_NOTLARI.md`'ye not et.

---

**DEVAMI PART 2'DE...**
