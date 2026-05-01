import { log } from './debug.js';
import * as Tech1 from './tech1-webcodecs-canvas2d.js';
import * as Tech3 from './tech3-jmuxer-mse.js';
import * as Tech5 from './tech5-webcodecs-mjpeg-img.js';

const modules = [Tech1, Tech3, Tech5];

function initAllModules() {
    log('info', 'global', 'Sistem Hazırlanıyor...');
    modules.forEach(m => {
        const mod = m.TechModule;
        if (!mod || !mod.id) return;
        const panel = document.getElementById(`panel-${mod.id}`);
        if (!panel) return;
        try {
            mod.init(panel);
            panel.querySelectorAll('button[data-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const action = btn.getAttribute('data-action');
                    if (mod[action]) mod[action]();
                });
            });
        } catch (e) {
            log('error', mod.id, `Init Hatası: ${e.message}`);
        }
    });
}

async function searchVideos(query) {
    log('info', 'global', `Arama: "${query}"`);
    const container = document.getElementById('search-results');
    container.innerHTML = `<div class="search-loading">Aranıyor...</div>`;

    try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=12`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();

        if (!data.results || data.results.length === 0) {
            container.innerHTML = `<div class="search-loading">Sonuç bulunamadı.</div>`;
            return;
        }

        container.innerHTML = '';
        data.results.forEach(v => {
            const dur = v.duration ? fmtDuration(v.duration) : '';
            const card = document.createElement('div');
            card.className = 'search-card';
            card.innerHTML = `
                <div class="search-thumb-wrap">
                    <img src="${v.thumbnail}" alt="" class="search-thumb" loading="lazy">
                    ${dur ? `<span class="search-dur">${dur}</span>` : ''}
                </div>
                <div class="search-info">
                    <div class="search-title">${v.title}</div>
                    <div class="search-channel">${v.channel || ''}</div>
                </div>
            `;
            card.addEventListener('click', () => {
                document.getElementById('search-input').value = `https://www.youtube.com/watch?v=${v.video_id}`;
                loadVideo(v.video_id);
            });
            container.appendChild(card);
        });
    } catch (e) {
        log('error', 'global', `Arama Hatası: ${e.message}`);
        container.innerHTML = `<div class="search-loading" style="color:#ff3333">Hata: ${e.message}</div>`;
    }
}

function fmtDuration(sec) {
    if (!sec) return '';
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
    return `${m}:${String(s % 60).padStart(2,'0')}`;
}

async function loadVideo(videoId) {
    log('info', 'global', `Video Hazırlanıyor: ${videoId}`);
    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = `<div style="color: #ffcc00; padding: 10px;">Hazırlanıyor: ${videoId}</div>`;

    try {
        const r = await fetch(`/api/extract/${videoId}`);
        if (!r.ok) throw new Error(`Sunucu Hatası: ${r.status}`);
        const data = await r.json();
        log('info', 'global', `Video Verileri Hazır: ${data.title}`);
        resultsContainer.innerHTML = `<div style="color: #00ff88; padding: 10px;">HAZIR: ${data.title}</div>`;

        modules.forEach(m => {
            if (m.TechModule && m.TechModule.load) {
                m.TechModule.load(data.token, data).catch(e =>
                    log('error', m.TechModule.id, `Yükleme Hatası: ${e.message}`)
                );
            }
        });
    } catch (e) {
        log('error', 'global', `Yükleme Başarısız: ${e.message}`);
        resultsContainer.innerHTML = `<div style="color: #ff3333; padding: 10px;">HATA: ${e.message}</div>`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    log('info', 'global', 'DOM Hazır, sistem başlatılıyor...');
    initAllModules();

    document.getElementById('search-btn').addEventListener('click', () => {
        const q = document.getElementById('search-input').value.trim();
        if (!q) return;
        // URL ise direkt yükle, değilse arama yap
        const match = q.match(/(?:v=|be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
        if (match) {
            loadVideo(match[1]);
        } else {
            searchVideos(q);
        }
    });

    // Enter tuşu desteği
    document.getElementById('search-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('search-btn').click();
    });
});

window.loadVideo = loadVideo;
