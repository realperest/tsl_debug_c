import logging
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

def extract(video_id: str):
    url = f"https://www.youtube.com/watch?v={video_id}"
    opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'nocheckcertificate': True,
        'format': 'best[ext=mp4][height<=480]/best[height<=480]/best',
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
            video_url = info.get('url')
            return {
                'video_id': video_id,
                'title': info.get('title'),
                'duration': info.get('duration'),
                'video': {
                    'url': video_url,
                    'codec': 'h264',
                    'width': info.get('width', 1280),
                    'height': info.get('height', 720),
                },
                'audio': {
                    'url': video_url,
                    'codec': 'aac',
                },
            }
        except Exception as e:
            logger.error(f"Extract hatası: {e}")
            return None
