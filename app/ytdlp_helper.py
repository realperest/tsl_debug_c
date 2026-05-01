import logging
from typing import Optional, Tuple

import yt_dlp

logger = logging.getLogger(__name__)

def search(query: str, limit: int = 15):
    """YouTube'da arama yapar (Canlı yayınlar hariç)."""
    opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
        'nocheckcertificate': True,
        'default_search': 'ytsearch',
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(f"ytsearch{limit + 10}:{query}", download=False)
            results = []
            for e in (info.get('entries') or []):
                is_live = e.get('live_status') == 'is_live' or e.get('is_live') is True
                if e and e.get('id') and not is_live and len(results) < limit:
                    results.append({
                        'video_id': e['id'],
                        'title': e.get('title', 'YouTube Video'),
                        'thumbnail': f"https://i.ytimg.com/vi/{e['id']}/hqdefault.jpg",
                        'duration': e.get('duration'),
                        'channel': e.get('channel', e.get('uploader', 'YouTube'))
                    })
            return results
        except Exception as e:
            logger.error(f"Arama hatası: {e}")
            return []

def get_trending(limit: int = 24):
    """YouTube trend videolarını çeker (Canlı yayınlar hariç)."""
    # Trend sayfası bazen hata verebilir, o yüzden direkt arama ile başlayalım veya fallback'i güçlendirelim
    opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
        'nocheckcertificate': True,
    }
    results = []
    
    # 1. Deneme: Direkt trend sayfası
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            # GL=TR bazen sorun çıkarıyor, genel trendleri deneyelim
            info = ydl.extract_info("https://www.youtube.com/feed/trending", download=False)
            for e in (info.get('entries') or []):
                is_live = e.get('live_status') == 'is_live' or e.get('is_live') is True
                if e and e.get('id') and not is_live and len(results) < limit:
                    results.append({
                        'video_id': e['id'],
                        'title': e.get('title', 'YouTube Video'),
                        'thumbnail': f"https://i.ytimg.com/vi/{e['id']}/hqdefault.jpg",
                        'duration': e.get('duration'),
                        'channel': e.get('uploader', 'YouTube')
                    })
        except Exception as e:
            logger.warning(f"Trend feed hatası: {e}")

    # 2. Deneme: Arama tabanlı trendler (Fallback)
    if not results:
        logger.info("Trend feed başarısız, arama fallback devreye giriyor...")
        results = search("trending videos", limit=limit)
        
    return results


def _video_audio_urls_from_info(info: dict) -> Tuple[Optional[str], Optional[str]]:
    """
    İstemci aynı imzalı progressive URL'e paralel iki HTTP baglantisi acarsa (MP4Box + <audio>),
    CDN / imza / ara proxy canlı ortamda stream'i bozabilir. Mümkünse ayri youtube stream URL kullanilir.
    """
    req = info.get('requested_formats')
    if isinstance(req, list):
        v_url = None
        a_url = None
        for f in req:
            vc_raw = str(f.get('vcodec') or '').lower()
            ac_raw = str(f.get('acodec') or '').lower()
            vc_none = vc_raw in ('', 'none')
            ac_none = ac_raw in ('', 'none')
            # Saf video izi veya görüntü taşıyan parça (DASH bazen iki parça döner)
            if not vc_none and ac_none:
                v_url = f.get('url') or v_url
            elif not ac_none and vc_none:
                a_url = f.get('url') or a_url
        if v_url and a_url and v_url != a_url:
            return v_url, a_url

    merged = info.get('url')
    if merged:
        return merged, merged
    if isinstance(req, list) and len(req) == 1 and req[0].get('url'):
        u = req[0]['url']
        return u, u
    return None, None


def extract(video_id: str):
    watch = f"https://www.youtube.com/watch?v={video_id}"
    # Önce mümkünse ayri kalite uyumlu video+audio ID'leri; olmazsa tek parça progressive
    opts_primary = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'nocheckcertificate': True,
        'format': (
            'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/'
            'bestvideo[height<=480][ext=mp4]+bestaudio/'
            'bestvideo[height<=480]+bestaudio/'
            'best[ext=mp4][height<=480]/best[height<=480]/best'
        ),
    }
    opts_fallback = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'nocheckcertificate': True,
        'format': 'best[ext=mp4][height<=480]/best[height<=480]/best',
    }
    try:
        with yt_dlp.YoutubeDL(opts_primary) as ydl:
            info = ydl.extract_info(watch, download=False)

        video_url, audio_url = _video_audio_urls_from_info(info)

        if not video_url or not audio_url:
            with yt_dlp.YoutubeDL(opts_fallback) as ydl:
                info = ydl.extract_info(watch, download=False)
            video_url, audio_url = _video_audio_urls_from_info(info)

        if not video_url or not audio_url:
            logger.error('Extract: ne birlesik ne ayrıştırılabilir URL uretildi')
            return None

        width = info.get('width', 1280)
        height = info.get('height', 720)

        if video_url != audio_url:
            logger.info('Extract: Ayri video ve ses URL kullanildi (tek URL ile cift baglanti riski yok)')
        else:
            logger.warning(
                'Extract: Video ve ses aynı progressive URL — istemci cift paralel GET acacak (bazı ortamlarda riskli)'
            )

        return {
            'video_id': video_id,
            'title': info.get('title'),
            'duration': info.get('duration'),
            'video': {
                'url': video_url,
                'codec': 'h264',
                'width': width,
                'height': height,
            },
            'audio': {
                'url': audio_url,
                'codec': 'aac',
            },
        }
    except Exception as e:
        logger.error(f"Extract hatası: {e}")
        return None
