import * as Tech1 from './tech1-webcodecs-canvas2d.js';
import * as Tech5 from './tech5-webcodecs-mjpeg-img.js';

const players = {
    yt1: Tech1.TechModule,
    yt2: Tech5.TechModule
};

function syncPlayPauseButtonUiForTech(id) {
    const p = players[id];
    if (p?.syncPlayButtonUi) {
        try {
            p.syncPlayButtonUi();
        } catch (e) {
            console.warn('[ui] Play düğmesi senkronu:', e);
        }
        return;
    }
    const btn = document.getElementById(`play-pause-${id}`);
    if (btn && !btn.querySelector('.yt-play-pause-icon')) {
        btn.textContent = p?.isPlaying ? '⏸' : '▶';
    }
}

const YT_FS_PATH_ENTER = 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 7v2h3v3h2V7h-5z';
const YT_FS_PATH_EXIT = 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';

function syncYoutubeFullscreenButtonIcons() {
    document.querySelectorAll('.yt-fs-btn[data-fs-root]').forEach((btn) => {
        const rid = btn.getAttribute('data-fs-root');
        const root = rid ? document.getElementById(rid) : null;
        const inlay = Boolean(root?.classList.contains('player-main--inlay-max'));
        const path = btn.querySelector('.yt-fs-icon path');
        if (path) path.setAttribute('d', inlay ? YT_FS_PATH_EXIT : YT_FS_PATH_ENTER);
        const label = inlay ? 'Normal boyuta dön' : 'Tam ekran';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    });
}

function bindYoutubeStyleFullscreenIcons() {
    if (document.body.dataset.tyTubeFsIcons) return;
    document.body.dataset.tyTubeFsIcons = '1';
    document.addEventListener('fullscreenchange', syncYoutubeFullscreenButtonIcons);
    document.addEventListener('webkitfullscreenchange', syncYoutubeFullscreenButtonIcons);
    document.addEventListener('ty-inlay-max-change', syncYoutubeFullscreenButtonIcons);
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.player-main--inlay-max').forEach((el) => {
            el.classList.remove('player-main--inlay-max');
            el.closest('.player-view-layout')?.classList.remove('player-view-layout--inlay-max');
        });
        syncYoutubeFullscreenButtonIcons();
    });
}

let currentView = 'home';
let loadedTrendingInSections = { yt1: false, yt2: false };
let speechSession = null;
let speechHintTimer = null;

function clearSpeechHintTimer() {
    if (speechHintTimer) {
        window.clearTimeout(speechHintTimer);
        speechHintTimer = null;
    }
}

function hideSpeechHint() {
    clearSpeechHintTimer();
    const box = document.getElementById('speech-hint');
    if (box) {
        box.textContent = '';
        box.classList.add('speech-hint-hidden');
    }
}

function showSpeechHint(message, ttlMs = 5500) {
    const box = document.getElementById('speech-hint');
    if (!box) return;
    clearSpeechHintTimer();
    box.textContent = message || '';
    if (!message) {
        box.classList.add('speech-hint-hidden');
        return;
    }
    box.classList.remove('speech-hint-hidden');
    if (ttlMs > 0 && Number.isFinite(ttlMs)) {
        speechHintTimer = window.setTimeout(() => {
            box.classList.add('speech-hint-hidden');
            box.textContent = '';
            speechHintTimer = null;
        }, ttlMs);
    }
}

/** Sekme / uygulama / sekme çıkışı: oynayan her şey dursun. */
function pausePlaybackWhenDocumentNotVisible(reason) {
    try {
        if (speechSession) {
            try {
                speechSession.abort();
            } catch (speechAbortErr) {
                console.warn('[arka plan] Ses oturumu kapatılamadı:', speechAbortErr);
            }
            speechSession = null;
            hideSpeechHint();
            document.querySelectorAll('.search-aux-btn--listening').forEach((el) =>
                el.classList.remove('search-aux-btn--listening')
            );
        }
        Object.keys(players).forEach((id) => {
            const p = players[id];
            if (typeof p.pause === 'function') p.pause();
            syncPlayPauseButtonUiForTech(id);
        });
    } catch (err) {
        console.warn('[arka plan] Duraklatma hatası:', reason, err);
    }
}

function attachPlaybackPauseOnLeave() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            pausePlaybackWhenDocumentNotVisible('visibilitychange');
        }
    });
    window.addEventListener('pagehide', () => {
        pausePlaybackWhenDocumentNotVisible('pagehide');
    });
}

function speechRecognitionErrorTurkish(code) {
    const map = {
        aborted: '',
        'no-speech': 'Konuşma algılanmadı. Tekrar mikrofon simgesine basıp konuşun.',
        'audio-capture': 'Mikrofona erişilemedi (bağlı veya izin?).',
        'not-allowed': 'Mikrofon izni yok veya tarayıcı engelliyor.',
        'permission-denied': 'Mikrofon izni reddedildi.',
        'service-not-allowed': 'Ses servisi bu ortamda kapalı olabilir (araç/sunucu politikası).',
        network: 'Ağ bağlantısı gerekli; ses servisine erişilemiyor.',
        'bad-grammar': 'Ses kuralları bu cihazda desteklenmiyor.'
    };
    return map[code] || (code ? `Ses hatası: ${code}` : '');
}

function lockSearchInput(input) {
    if (!input) return;
    input.readOnly = true;
    input.setAttribute('readonly', 'readonly');
    input.classList.remove('search-input-unlocked');
}

function unlockSearchInput(input) {
    if (!input) return;
    input.readOnly = false;
    input.removeAttribute('readonly');
    input.classList.add('search-input-unlocked');
}

async function startVoiceSearch(techId) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const input = document.getElementById(`search-input-${techId}`);
    const voiceBtn = document.getElementById(`voice-btn-${techId}`);
    if (!input) return;

    document.querySelectorAll('.search-aux-btn--listening').forEach((el) => el.classList.remove('search-aux-btn--listening'));

    if (!SpeechRec) {
        showSpeechHint('Bu cihaz / tarayıcı Web Speech (SpeechRecognition) vermiyor; mikrofon simgesi burada işlevsiz kalır.', 7000);
        console.warn('[ses] SpeechRecognition yok — Tesla dahil bazı gömülü tarayıcılar bunu kapalı tutar.');
        return;
    }

    if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
        showSpeechHint('Ses için https:// veya localhost üzerinden açmalısınız.', 6000);
        return;
    }

    if (navigator.mediaDevices?.getUserMedia) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => { t.stop(); });
        } catch (micErr) {
            console.warn('[ses] getUserMedia reddedildi veya mikrofon yok', micErr);
            showSpeechHint('Mikrofon kullanılamıyor — izni kontrol edin.', 5500);
            return;
        }
    }

    if (speechSession) {
        try {
            speechSession.abort();
        } catch (abortErr) {
            console.warn('Önceki ses oturumu sonlandırılamadı', abortErr);
        }
        speechSession = null;
    }

    const rec = new SpeechRec();
    rec.lang = 'tr-TR';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    speechSession = rec;

    rec.onstart = () => {
        voiceBtn?.classList.add('search-aux-btn--listening');
        showSpeechHint('Dinleniyor… Şimdi konuşabilirsiniz.', 0);
    };

    rec.onresult = (ev) => {
        hideSpeechHint();
        voiceBtn?.classList.remove('search-aux-btn--listening');
        let tx = '';
        try {
            const first = ev.results && ev.results[0] && ev.results[0][0];
            tx = first && first.transcript ? String(first.transcript).trim() : '';
        } catch (parseErr) {
            console.warn('[ses] Sonuç ayrıştırılamadı', parseErr);
        }
        if (tx) {
            input.value = tx;
            performSearch(techId, tx);
        } else {
            showSpeechHint('Metin çıkmadı. Tekrar deneyin.', 4000);
        }
    };

    rec.onerror = (ev) => {
        voiceBtn?.classList.remove('search-aux-btn--listening');
        speechSession = null;
        const code = ev && ev.error ? String(ev.error) : '';
        if (code !== 'aborted') {
            console.warn('[ses] SpeechRecognition.onerror:', code);
        }
        hideSpeechHint();
        if (code === 'aborted') return;
        const msg = speechRecognitionErrorTurkish(code);
        if (msg) showSpeechHint(msg, 6200);
    };

    rec.onend = () => {
        voiceBtn?.classList.remove('search-aux-btn--listening');
        speechSession = null;
        const box = document.getElementById('speech-hint');
        if (
            box &&
            !box.classList.contains('speech-hint-hidden') &&
            box.textContent.startsWith('Dinleniyor')
        ) {
            hideSpeechHint();
        }
    };

    try {
        rec.start();
    } catch (startErr) {
        speechSession = null;
        voiceBtn?.classList.remove('search-aux-btn--listening');
        console.warn('[ses] rec.start() senkron hata:', startErr);
        showSpeechHint('Ses tanıması bu oturumda başlatılamıyor (tarayıcı kısıtı).', 6000);
    }
}

function initSearchControls(techId) {
    const input = document.getElementById(`search-input-${techId}`);
    const kb = document.getElementById(`keyboard-btn-${techId}`);
    const voice = document.getElementById(`voice-btn-${techId}`);
    if (!input || !kb || !voice) return;

    lockSearchInput(input);

    input.addEventListener('pointerdown', (e) => {
        if (input.readOnly) e.preventDefault();
    });
    input.addEventListener('click', (e) => {
        if (input.readOnly) e.preventDefault();
    });

    input.addEventListener('blur', () => {
        window.setTimeout(() => {
            lockSearchInput(input);
        }, 220);
    });

    kb.addEventListener('click', (e) => {
        e.preventDefault();
        unlockSearchInput(input);
        input.focus({ preventScroll: true });
    });

    voice.addEventListener('click', (e) => {
        e.preventDefault();
        startVoiceSearch(techId).catch((promiseErr) => {
            console.warn('[ses] startVoiceSearch beklenmedik:', promiseErr);
            showSpeechHint('Sesle arama başlatılamadı.', 5000);
        });
    });
}

async function init() {
    console.log("TobeTube Başlatılıyor...");

    bindYoutubeStyleFullscreenIcons();

    if (players.yt1) players.yt1.init(document.getElementById('view-yt1'));
    if (players.yt2) players.yt2.init(document.getElementById('view-yt2'));

    syncYoutubeFullscreenButtonIcons();

    // Navigasyon
    document.querySelectorAll('.menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const view = item.getAttribute('data-view');
            if (view) switchView(view);
        });
    });

    // Arama ve Chipler
    ['yt1', 'yt2'].forEach(id => {
        const btn = document.getElementById(`search-btn-${id}`);
        const input = document.getElementById(`search-input-${id}`);
        if (btn && input) {
            btn.addEventListener('click', () => performSearch(id, input.value.trim()));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') btn.click();
            });
        }

        document.querySelectorAll(`#view-${id} .chip`).forEach(chip => {
            chip.addEventListener('click', () => {
                document.querySelectorAll(`#view-${id} .chip`).forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                const q = chip.getAttribute('data-query');
                q ? performSearch(id, q) : loadTrendingInSection(id);
            });
        });

        // Click on video container to toggle play/pause
        const videoArea = document.getElementById(`video-click-${id}`);
        if (videoArea) {
            videoArea.addEventListener('click', () => {
                const p = players[id];
                if (p) {
                    if (p.isPlaying) p.pause();
                    else p.play();
                    syncPlayPauseButtonUiForTech(id);
                }
            });
        }

        initSearchControls(id);
    });

    // Geri dön butonları (Hem eski hem yeni selector için)
    document.querySelectorAll('.back-to-grid, .back-to-grid-small').forEach(btn => {
        btn.addEventListener('click', () => togglePlayer(btn.getAttribute('data-target'), false));
    });

    document.getElementById('nav-home-logo')?.addEventListener('click', () => switchView('home'));

    attachPlaybackPauseOnLeave();

    handleVersioning();
}

function handleVersioning() {
    const latestVersion = 'C 260501.0085';
    const viewedKey = 'tobetube_last_viewed';
    const lastViewed = localStorage.getItem(viewedKey);
    const versionEl = document.querySelector('.version-badge .latest');
    if (versionEl) {
        versionEl.innerHTML = `<strong>${latestVersion}</strong>`;
        versionEl.style.color = (lastViewed !== latestVersion) ? '#00ff88' : 'var(--text-secondary)';
        setTimeout(() => localStorage.setItem(viewedKey, latestVersion), 5000);
    }
}

function switchView(viewId) {
    if (currentView === viewId) return;
    Object.values(players).forEach(p => p.pause && p.pause());
    ['yt1', 'yt2'].forEach((id) => syncPlayPauseButtonUiForTech(id));
    ['yt1', 'yt2'].forEach((id) => {
        document.getElementById(`player-fs-root-${id}`)?.classList.remove('player-main--inlay-max');
        document.getElementById(`player-container-${id}`)?.classList.remove('player-view-layout--inlay-max');
    });
    syncYoutubeFullscreenButtonIcons();
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
    document.getElementById(`view-${viewId}`)?.classList.add('active');
    document.querySelectorAll('.menu-item').forEach(item => {
        item.classList.remove('active');
        if (item.getAttribute('data-view') === viewId) item.classList.add('active');
    });

    if (viewId === 'yt1' || viewId === 'yt2') {
        togglePlayer(viewId, false);
        if (!loadedTrendingInSections[viewId]) {
            loadTrendingInSection(viewId);
            loadedTrendingInSections[viewId] = true;
        }
    }
    currentView = viewId;
    window.scrollTo(0, 0);
}

function togglePlayer(techId, show) {
    const grid = document.getElementById(`grid-${techId}`);
    const player = document.getElementById(`player-container-${techId}`);
    const toolbar = document.querySelector(`#view-${techId} .browse-toolbar-row`);
    const browseBody = document.querySelector(`#view-${techId} .browse-body`);

    if (show) {
        if (browseBody) browseBody.style.display = 'none';
        if (toolbar) toolbar.style.display = 'none';
        if (grid) grid.style.display = 'none';
        if (player) player.style.display = 'flex';
    } else {
        if (browseBody) browseBody.style.display = '';
        if (toolbar) toolbar.style.display = '';
        if (grid) grid.style.display = 'grid';
        if (player) player.style.display = 'none';
        document.getElementById(`player-fs-root-${techId}`)?.classList.remove('player-main--inlay-max');
        player?.classList.remove('player-view-layout--inlay-max');
        syncYoutubeFullscreenButtonIcons();
        if (players[techId]?.pause) players[techId].pause();
    }
}

async function loadTrendingInSection(techId) {
    const grid = document.getElementById(`grid-${techId}`);
    grid.innerHTML = `<div class="loader"><div class="spinner"></div></div>`;
    try {
        const r = await fetch('/api/trending?limit=15');
        const d = await r.json();
        renderVideoGrid(techId, grid, d.results);
    } catch (e) { grid.innerHTML = `<div style="color:red;padding:20px;">Hata oluştu.</div>`; }
}

async function performSearch(techId, query) {
    if (!query) return;
    const grid = document.getElementById(`grid-${techId}`);
    grid.innerHTML = `<div class="loader"><div class="spinner"></div></div>`;
    togglePlayer(techId, false);
    try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const d = await r.json();
        renderVideoGrid(techId, grid, d.results);
    } catch (e) { grid.innerHTML = `<div style="color:red;padding:20px;">Hata oluştu.</div>`; }
}

function renderVideoGrid(techId, container, videos) {
    if (!videos || videos.length === 0) {
        container.innerHTML = `<div style="padding:20px;">Sonuç bulunamadı.</div>`;
        return;
    }
    container.innerHTML = '';
    videos.forEach(v => {
        const card = document.createElement('div');
        card.className = 'video-card';
        card.innerHTML = `
            <div class="thumb-wrap">
                <img src="${v.thumbnail}" alt="${v.title}" loading="lazy">
                ${v.duration ? `<span class="video-duration">${formatTime(v.duration)}</span>` : ''}
            </div>
            <div class="video-info">
                <div class="video-title">${v.title}</div>
                <div class="video-meta">${v.channel}</div>
            </div>
        `;
        card.addEventListener('click', () => playVideo(techId, v.video_id));
        container.appendChild(card);
    });
}

async function playVideo(techId, videoId) {
    togglePlayer(techId, true);
    const p = players[techId];
    const t = document.getElementById(`title-${techId}`);
    t.textContent = "Video Hazırlanıyor...";

    try {
        const r = await fetch(`/api/extract/${videoId}`);
        const d = await r.json();
        t.textContent = d.title;
        
        loadSidebarRecommendations(techId);

        await p.load(d.token, d);
        if (p.play) p.play();
        syncPlayPauseButtonUiForTech(techId);
    } catch (e) { t.textContent = "HATA: Video yüklenemedi."; }
}

async function loadSidebarRecommendations(techId) {
    const sidebar = document.getElementById(`recommendations-${techId}`);
    if (!sidebar) return;
    sidebar.innerHTML = `<div class="loader"><div class="spinner"></div></div>`;
    try {
        const r = await fetch('/api/trending?limit=10');
        const d = await r.json();
        sidebar.innerHTML = '';
        d.results.forEach(v => {
            const sc = document.createElement('div');
            sc.className = 'sidebar-card';
            sc.innerHTML = `
                <div class="sidebar-thumb"><img src="${v.thumbnail}"></div>
                <div class="sidebar-info">
                    <div class="sidebar-title">${v.title}</div>
                    <div class="sidebar-meta">${v.channel}</div>
                </div>
            `;
            sc.addEventListener('click', () => playVideo(techId, v.video_id));
            sidebar.appendChild(sc);
        });
    } catch (e) { sidebar.innerHTML = ''; }
}

function formatTime(sec) {
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
    return `${m}:${String(s % 60).padStart(2,'0')}`;
}

document.addEventListener('DOMContentLoaded', init);
