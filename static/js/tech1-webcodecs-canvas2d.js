import { log, setLED } from './debug.js';

/** Oynat / duraklat tek SVG path (duruma göre d değişir) */
const YT_PLAY_ICON_D = 'M8 6.82v10.36c0 .79.87 1.27 1.54.82l8.09-5.18a.98.98 0 000-1.65l-8.09-5.17A.997.997 0 008 6.82z';
const YT_PAUSE_ICON_D = 'M8 19h3V5H8v14zm5-14v14h3V5h-3z';

/** Ses: açık (hoparlör + dalga), kapalı/sessiz (hoparlör + çizgi) */
const YT_VOL_ICON_ON_D = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z';
const YT_VOL_ICON_OFF_D = 'M3 9v6h4l5 5V4L7 9H3zM17.75 5.03l1.22 1.22L7.62 21.61l-1.21-1.21z';

/** GECICI TANI: true iken pause/resume/bookmark/mp4.seek yolu yok; kuyruk için min 1 kare; ilerleme cubuguna tiklayinca seek yapilmaz */
const DIAG_BYPASS_PAUSE_RESUME = true;

export const TechModule = {
    id: 'yt1',
    name: 'WebCodecs + Canvas 2D',
    canvas: null,
    ctx: null,
    audio: null,
    decoder: null,
    mp4boxfile: null,
    frameCount: 0,
    firstFrameSeen: false,
    isPlaying: false,
    isConfigured: false,
    isAVCC: false,
    timescale: 90000,
    pendingSamples: [],
    duration: 0,
    renderGen: 0,
    _progressRaf: null,
    pausedAtSec: 0,
    _needResyncOnPlay: false,
    _resumeWatchdog: null,
    pauseBookmarkSec: 0,
    _resumeRewindSec: 1,
    _syncAudioFloorSec: null,
    _syncAudioCeilSec: null,
    _stageOverlayReady: false,
    _elOverlay: null,
    _overlaySpinWrap: null,
    _overlayPause: null,
    /** Orta spinner: yalnizca yeni yuk / oynarken seek sonrasi ilk kare+ses hazirlanana kadar */
    _spinnerUntilPrimed: false,
    /** Canvas gercekten en az bir decoded kare cizdikten sonra orta spinner mantiksal olarak yasak */
    _surfacePaintedOnce: false,

    /** Sunucunun video ve ses icin ayri URL kullanmak yerine tek progressive MP4 verdiginde (canli A/V kaymasini azaltir). */
    _fallbackAudioUrl: null,
    _unifiedAv: false,
    _mediaSource: null,
    _mseObjectUrl: null,
    _audioSourceBuffer: null,
    _mseAudioMime: null,
    _mseQueue: [],
    _msePumpFinished: false,

    // Buffer Logic
    frameQueue: [],
    _isBuffering: false,
    MIN_BUFFER: 10, // 480p ile 10 kare ideal
    MAX_BUFFER: 80, // Daha fazla veri biriktir

    get isBuffering() { return this._isBuffering; },
    set isBuffering(v) {
        this._isBuffering = v;
        this._syncStageOverlay();
    },

    init(panel) {
        this.canvas = panel.querySelector('canvas') || document.getElementById(`canvas-${this.id}`);
        this.ctx = this.canvas.getContext('2d');
        this.audio = new Audio();
        this.audio.volume = 1.0;
        this.audio.preload = 'auto';

        const controlsContainer = document.getElementById(`controls-${this.id}`);
        if (controlsContainer) this._createControls(controlsContainer);

        const volSlider = document.getElementById(`vol-${this.id}`);
        if (volSlider) {
            volSlider.addEventListener('input', () => {
                const v = parseFloat(volSlider.value);
                this.audio.volume = v;
                if (v > 0.001) this.audio.muted = false;
                this._syncMuteIcon();
            });
        }

        const muteBtn = document.getElementById(`mute-${this.id}`);
        if (muteBtn) {
            muteBtn.addEventListener('click', () => {
                this.audio.muted = !this.audio.muted;
                this._syncMuteIcon();
            });
        }

        const fsBtn = document.getElementById(`fs-btn-${this.id}`);
        if (fsBtn) fsBtn.addEventListener('click', () => this._toggleFullscreen());

        this._syncMuteIcon();
        this.syncPlayButtonUi();

        const progressWrap = document.getElementById(`progress-wrap-${this.id}`);
        if (progressWrap) {
            progressWrap.addEventListener('click', (e) => this._onSeekClick(e, progressWrap));
            progressWrap.addEventListener('touchend', (e) => {
                e.preventDefault();
                this._onSeekClick(e.changedTouches[0], progressWrap);
            });
        }
        this._ensureStageOverlay();
        this._syncStageOverlay();
    },

    _ensureStageOverlay() {
        if (this._stageOverlayReady) return;
        const wrap = document.getElementById(`video-click-${this.id}`);
        if (!wrap) return;
        let layer = wrap.querySelector('.player-stage-overlay');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'player-stage-overlay';
            layer.setAttribute('aria-hidden', 'true');
            layer.innerHTML = `
                <div class="player-overlay-spinner-wrap">
                    <div class="player-overlay-spinner"></div>
                    <span class="player-overlay-label">Video hazırlanıyor…</span>
                </div>
                <div class="player-overlay-pause" hidden>
                    <svg class="pause-disk" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="60" cy="60" r="56" fill="rgba(0,0,0,0.45)"/>
                        <rect x="38" y="34" width="14" height="52" rx="3" fill="#fff"/>
                        <rect x="68" y="34" width="14" height="52" rx="3" fill="#fff"/>
                    </svg>
                </div>`;
            wrap.appendChild(layer);
        }
        this._elOverlay = layer;
        this._overlaySpinWrap = layer.querySelector('.player-overlay-spinner-wrap');
        this._overlayPause = layer.querySelector('.player-overlay-pause');
        if (this._overlaySpinWrap) this._overlaySpinWrap.removeAttribute('hidden');
        this._stageOverlayReady = true;
    },

    _syncStageOverlay() {
        this._ensureStageOverlay();
        if (!this._overlaySpinWrap || !this._overlayPause) return;
        const showPause = !this.isPlaying && this.duration > 0;
        this._overlayPause.hidden = !showPause;
        const showSpin = !this._surfacePaintedOnce && this._spinnerUntilPrimed;
        this._overlaySpinWrap.classList.toggle('player-overlay-spinner-visible', Boolean(showSpin));
    },

    _markSurfacePainted() {
        if (this._surfacePaintedOnce) return;
        this._surfacePaintedOnce = true;
        this._syncStageOverlay();
    },

    _hardTeardownUnifiedMse() {
        this._msePumpFinished = false;
        this._mseAudioMime = null;
        this._mseQueue = [];
        this._audioSourceBuffer = null;
        if (this._mediaSource) {
            try {
                if (this._mediaSource.readyState === 'open') {
                    this._mediaSource.endOfStream();
                }
            } catch (e) {}
            this._mediaSource = null;
        }
        if (this._mseObjectUrl) {
            try {
                URL.revokeObjectURL(this._mseObjectUrl);
            } catch (e2) {}
            this._mseObjectUrl = null;
        }
        this._unifiedAv = false;
    },

    _beginUnifiedMp4Audio(info) {
        this._fallbackAudioUrl = (info.audio && info.audio.url_path) ? info.audio.url_path : '';
        try {
            const ms = new MediaSource();
            this._mediaSource = ms;
            this._mseObjectUrl = URL.createObjectURL(ms);
            this.audio.src = this._mseObjectUrl;
            this.audio.load();
            ms.addEventListener('sourceopen', () => {
                this._attemptMseSourceBufferAttach();
            });
        } catch (e) {
            log('warn', this.id, `MediaSource: ${e?.message || e}`);
            this._fallbackToSeparateAudioTrack();
        }
    },

    _fallbackToSeparateAudioTrack() {
        const url = this._fallbackAudioUrl;
        this._hardTeardownUnifiedMse();
        if (url) {
            try {
                this.audio.pause();
                this.audio.src = url;
                this.audio.load();
            } catch (e) {
                log('warn', this.id, `Ses fallback: ${e?.message || e}`);
            }
        }
    },

    _attemptMseSourceBufferAttach() {
        if (!this._unifiedAv || !this._mediaSource) return;
        if (this._mediaSource.readyState !== 'open') return;
        if (this._audioSourceBuffer || !this._mseAudioMime) return;
        try {
            this._audioSourceBuffer = this._mediaSource.addSourceBuffer(this._mseAudioMime);
        } catch (e) {
            log('warn', this.id, `addSourceBuffer: ${e?.message || e}`);
            this._fallbackToSeparateAudioTrack();
            return;
        }
        this._pumpMseAppend();
    },

    _queueMseBytesFromReadable(value) {
        if (!this._unifiedAv || !value) return;
        const u8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        this._mseQueue.push(u8);
        if (this._audioSourceBuffer) this._pumpMseAppend();
    },

    _pumpMseAppend() {
        const sb = this._audioSourceBuffer;
        if (!sb || !this._unifiedAv) return;

        const step = () => {
            try {
                if (!this._audioSourceBuffer || sb !== this._audioSourceBuffer) return;

                if (sb.updating) {
                    sb.addEventListener('updateend', step, { once: true });
                    return;
                }
                if (this._mseQueue.length === 0) {
                    if (this._msePumpFinished && this._mediaSource && this._mediaSource.readyState === 'open') {
                        try {
                            this._mediaSource.endOfStream();
                        } catch (eosErr) {}
                    }
                    return;
                }
                const chunk = this._mseQueue.shift();
                sb.appendBuffer(chunk);
                sb.addEventListener('updateend', step, { once: true });
            } catch (err) {
                log('error', this.id, `MSE append: ${err?.message || err}`);
                this._fallbackToSeparateAudioTrack();
            }
        };
        step();
    },

    _finalizeMseOnPumpDone() {
        this._msePumpFinished = true;
        this._pumpMseAppend();
    },

    _computeResumeAudioSyncTime(frameTsSec) {
        let t = frameTsSec;
        if (typeof this._syncAudioCeilSec === 'number') {
            t = Math.min(t, this._syncAudioCeilSec);
        }
        if (typeof this._syncAudioFloorSec === 'number') {
            t = Math.max(t, this._syncAudioFloorSec);
        }
        return t;
    },

    syncPlayButtonUi() {
        const btn = document.getElementById(`play-pause-${this.id}`);
        if (!btn) return;
        const path = btn.querySelector('.yt-play-pause-icon path');
        if (path) {
            path.setAttribute('d', this.isPlaying ? YT_PAUSE_ICON_D : YT_PLAY_ICON_D);
            const lab = this.isPlaying ? 'Duraklat' : 'Oynat';
            btn.setAttribute('aria-label', lab);
            btn.title = lab;
            return;
        }
        btn.textContent = this.isPlaying ? '⏸' : '▶';
    },

    _syncMuteIcon() {
        const muteBtn = document.getElementById(`mute-${this.id}`);
        if (!muteBtn) return;
        const path = muteBtn.querySelector('.yt-vol-icon path');
        if (!path) return;
        const muted = Boolean(this.audio?.muted);
        const vol = typeof this.audio?.volume === 'number' ? this.audio.volume : 1;
        const silent = muted || vol < 0.02;
        path.setAttribute('d', silent ? YT_VOL_ICON_OFF_D : YT_VOL_ICON_ON_D);
        const lab = muted ? 'Sesi aç' : 'Sesi kapat';
        muteBtn.setAttribute('aria-label', lab);
        muteBtn.title = lab;
    },

    _toggleFullscreen() {
        const root = document.getElementById(`player-fs-root-${this.id}`);
        if (!root) {
            console.warn('[tam ekran] Oynatıcı kökü yok:', this.id);
            return;
        }
        const layout = root.closest('.player-view-layout');
        const doc = document;
        const native = doc.fullscreenElement || doc.webkitFullscreenElement;
        if (native) {
            const ex = doc.exitFullscreen || doc.webkitExitFullscreen;
            if (ex) ex.call(doc).catch((e) => console.warn('[tam ekran] Yerel tam ekrandan çıkış', e));
        }
        const max = root.classList.toggle('player-main--inlay-max');
        layout?.classList.toggle('player-view-layout--inlay-max', Boolean(max));
        document.dispatchEvent(new CustomEvent('ty-inlay-max-change'));
    },

    _createControls(container) {
        const fsRootId = `player-fs-root-${this.id}`;
        container.innerHTML = `
            <div class="player-controls-inner yt-controls-bar">
                <div class="controls-row yt-controls-toolbar yt-controls-one-line">
                    <div class="left-ctrl yt-ctrl-left">
                        <div class="yt-chip">
                            <button type="button" class="ctrl-btn yt-ic-btn" id="play-pause-${this.id}" title="Oynat" aria-label="Oynat">
                                <svg class="yt-play-pause-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="${YT_PLAY_ICON_D}"/></svg>
                            </button>
                        </div>
                        <div class="yt-chip yt-chip-vol">
                            <button type="button" class="ctrl-btn yt-ic-btn" id="mute-${this.id}" title="Sesi kapat" aria-label="Sesi kapat">
                                <svg class="yt-vol-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="${YT_VOL_ICON_ON_D}"/></svg>
                            </button>
                            <input type="range" class="vol-slider yt-vol-slider" id="vol-${this.id}" min="0" max="1" step="0.05" value="1" aria-label="Ses seviyesi">
                        </div>
                        <div class="yt-chip yt-chip-time">
                            <span class="time-display"><span id="time-${this.id}">0:00</span> / <span id="duration-${this.id}">0:00</span></span>
                        </div>
                    </div>
                    <div class="progress-container yt-progress-wrap yt-progress-inline">
                        <div class="progress-bar-wrap yt-progress-bar" id="progress-wrap-${this.id}">
                            <div class="progress-buffer" id="progress-buffer-${this.id}"></div>
                            <div class="progress-fill" id="progress-fill-${this.id}"></div>
                            <div class="progress-thumb" id="progress-thumb-${this.id}"></div>
                        </div>
                    </div>
                    <div class="right-ctrl yt-ctrl-right">
                        <div class="yt-chip yt-chip-fs-only">
                            <button type="button" class="ctrl-btn yt-ic-btn yt-fs-btn" id="fs-btn-${this.id}" data-fs-root="${fsRootId}" title="Tam ekran" aria-label="Tam ekran">
                                <svg class="yt-fs-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 7v2h3v3h2V7h-5z"/></svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        const ppBtn = document.getElementById(`play-pause-${this.id}`);
        if (ppBtn) {
            ppBtn.addEventListener('click', () => {
                if (this.isPlaying) this.pause();
                else this.play();
            });
        }
    },

    _onSeekClick(e, wrap) {
        if (!this.duration) return;
        if (DIAG_BYPASS_PAUSE_RESUME) return;
        const rect = wrap.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this.seek(ratio * this.duration);
    },

    _updateProgress() {
        if (!this.duration) return;
        const cur = this.audio.currentTime;
        const pct = Math.min((cur / this.duration) * 100, 100);
        const fill = document.getElementById(`progress-fill-${this.id}`);
        const thumb = document.getElementById(`progress-thumb-${this.id}`);
        const timeEl = document.getElementById(`time-${this.id}`);
        if (fill) fill.style.width = `${pct}%`;
        if (thumb) thumb.style.left = `${pct}%`;
        if (timeEl) timeEl.textContent = this._fmt(cur);
        if (this.isPlaying) this._progressRaf = requestAnimationFrame(() => this._updateProgress());
    },

    _fmt(sec) {
        const s = Math.floor(sec);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    },

    play() {
        if (this.isPlaying) return;

        if (DIAG_BYPASS_PAUSE_RESUME) {
            this.pauseBookmarkSec = 0;
            this._syncAudioFloorSec = null;
            this._syncAudioCeilSec = null;
            this._needResyncOnPlay = false;
            this.renderGen++;
            this.isPlaying = true;
            this._syncStageOverlay();
            const bufNeed = 1;
            this.isBuffering = this.frameQueue.length < bufNeed;
            if (this.mp4boxfile) {
                try { this.mp4boxfile.start(); } catch (e) {}
            }
            if (!this.isBuffering && this.frameQueue.length >= bufNeed) {
                this._finalizeBufferAndStartSynced();
            }
            this._startPlaybackLoop();
            this._updateProgress();
            this._syncStageOverlay();
            this.syncPlayButtonUi();
            return;
        }

        this.isPlaying = true;
        this._needResyncOnPlay = true;
        this._syncStageOverlay();

        const bookmark = (typeof this.pauseBookmarkSec === 'number' && !Number.isNaN(this.pauseBookmarkSec))
            ? this.pauseBookmarkSec
            : 0;

        /* Pause→Resume: bookmark = pause anı. Seek (bookmark - 1sn) + ses en fazla bookmark'a
         * çekilir; keyframe ileride olsa bile “ileri sıçrama” olmaz. */
        if (bookmark > 0 && this.mp4boxfile) {
            const resumeSeek = Math.max(0, bookmark - this._resumeRewindSec);
            this._syncAudioFloorSec = resumeSeek;
            this._syncAudioCeilSec = bookmark;
            this.seek(resumeSeek, { fromResume: true });
            return;
        }

        /* İlk play (≈0 sn) veya kuyruk zaten dolu ise burada doğrudan senkron başlat */
        this.renderGen++;
        this.isBuffering = this.frameQueue.length < this.MIN_BUFFER;
        if (this.mp4boxfile) {
            try { this.mp4boxfile.start(); } catch (e) {}
        }
        if (!this.isBuffering && this.frameQueue.length >= this.MIN_BUFFER) {
            this._finalizeBufferAndStartSynced();
        }
        this._startPlaybackLoop();
        this._syncStageOverlay();
        this.syncPlayButtonUi();
    },

    pause() {
        if (!this.isPlaying) return;

        if (DIAG_BYPASS_PAUSE_RESUME) {
            this.isPlaying = false;
            this.pauseBookmarkSec = 0;
            this.pausedAtSec = this.audio.currentTime || 0;
            this.audio.pause();
            this.renderGen++;
            if (this._resumeWatchdog) { clearTimeout(this._resumeWatchdog); this._resumeWatchdog = null; }
            if (this._progressRaf) { cancelAnimationFrame(this._progressRaf); this._progressRaf = null; }
            this._syncStageOverlay();
            this.syncPlayButtonUi();
            return;
        }

        this.isPlaying = false;
        const t = this.audio.currentTime || 0;
        this.pauseBookmarkSec = t;
        this.pausedAtSec = t;
        this.audio.pause();
        this.renderGen++;
        if (this._resumeWatchdog) { clearTimeout(this._resumeWatchdog); this._resumeWatchdog = null; }
        // Soft-pause: MP4Box stop etme. Tesla'da stop→start bazen sample üretimini kilitliyor.
        if (this._progressRaf) { cancelAnimationFrame(this._progressRaf); this._progressRaf = null; }
        this._syncStageOverlay();
        this.syncPlayButtonUi();
    },

    seek(timeSec, opts) {
        if (DIAG_BYPASS_PAUSE_RESUME) return;
        const fromResume = opts && opts.fromResume === true;
        if (this._resumeWatchdog) { clearTimeout(this._resumeWatchdog); this._resumeWatchdog = null; }
        if (this.isPlaying) this._spinnerUntilPrimed = true;
        this.renderGen++;
        this.frameQueue.forEach(f => f.close());
        this.frameQueue = [];
        this.audio.pause();
        this.audio.currentTime = timeSec;
        this.pausedAtSec = timeSec;
        if (!fromResume) {
            this.pauseBookmarkSec = 0;
            this._syncAudioFloorSec = null;
            this._syncAudioCeilSec = null;
        }
        this._needResyncOnPlay = true;
        this.isBuffering = true;
        if (this.decoder && this.decoder.state === 'configured') this.decoder.flush().catch(() => {});
        if (this.mp4boxfile) {
            this.mp4boxfile.seek(timeSec, true);
            this.mp4boxfile.start();
        }
        this.firstFrameSeen = false;
        if (this.isPlaying) this._startPlaybackLoop();
    },

    reset() {
        this.isPlaying = false;
        this.isConfigured = false;
        this.isBuffering = false;
        this.pausedAtSec = 0;
        this.pauseBookmarkSec = 0;
        this._syncAudioFloorSec = null;
        this._syncAudioCeilSec = null;
        this._spinnerUntilPrimed = false;
        this._surfacePaintedOnce = false;
        this._needResyncOnPlay = false;
        if (this._resumeWatchdog) { clearTimeout(this._resumeWatchdog); this._resumeWatchdog = null; }
        this.frameQueue.forEach(f => f.close());
        this.frameQueue = [];
        this.firstFrameSeen = false;
        this.pendingSamples = [];
        this.frameCount = 0;
        if (this._progressRaf) { cancelAnimationFrame(this._progressRaf); this._progressRaf = null; }
        this.audio.pause();
        this.audio.src = '';
        this._fallbackAudioUrl = null;
        this._hardTeardownUnifiedMse();
        if (this.decoder) { try { this.decoder.close(); } catch(e) {} this.decoder = null; }
        if (this.mp4boxfile) { try { this.mp4boxfile.flush(); } catch(e) {} this.mp4boxfile = null; }
        this._syncStageOverlay();
    },

    async load(token, info) {
        this.reset();
        this._spinnerUntilPrimed = true;
        this._ensureStageOverlay();
        this._syncStageOverlay();
        this._msePumpFinished = false;
        this._mseQueue = [];
        const unified = Boolean(info.unified_av_stream);
        if (
            unified
            && typeof MediaSource !== 'undefined'
            && typeof MediaSource.isTypeSupported === 'function'
            && MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')
        ) {
            this._unifiedAv = true;
            this._beginUnifiedMp4Audio(info);
        } else if (info.audio && info.audio.url_path) {
            this._unifiedAv = false;
            this.audio.src = info.audio.url_path;
            this.audio.load();
        }
        try {
            this.mp4boxfile = MP4Box.createFile();
            this.mp4boxfile.onReady = (readyInfo) => {
                const track = readyInfo.videoTracks[0];
                if (!track) return;
                this.timescale = track.timescale || 90000;
                this.duration = readyInfo.duration / readyInfo.timescale;
                const durEl = document.getElementById(`duration-${this.id}`);
                if (durEl) durEl.textContent = this._fmt(this.duration);
                const avcCDesc = this.getAVCCFromMP4Box(track);
                const config = { codec: track.codec, codedWidth: track.track_width, codedHeight: track.track_height };
                if (avcCDesc) { config.description = avcCDesc; this.isAVCC = true; }
                this.decoder = new VideoDecoder({
                    output: (frame) => this.onFrame(frame),
                    error: (e) => log('error', this.id, `Decoder: ${e.message}`)
                });
                this.decoder.configure(config);
                this.isConfigured = true;
                if (this._unifiedAv) {
                    const ats = readyInfo.audioTracks || [];
                    if (ats[0]) {
                        const rawCodec = (ats[0].codec || 'mp4a.40.2').trim();
                        const codec = /^[a-zA-Z0-9.]+$/.test(rawCodec) ? rawCodec : 'mp4a.40.2';
                        this._mseAudioMime = `audio/mp4; codecs="${codec}"`;
                    } else {
                        log('warn', this.id, 'Birlesik akista ses izi yok; ayri ses baglantisi.');
                        this._fallbackToSeparateAudioTrack();
                    }
                    this._attemptMseSourceBufferAttach();
                }
                for (const s of this.pendingSamples) this.sendSample(s);
                this.pendingSamples = [];
                const m = this.mp4boxfile.setExtractionConfig ? 'setExtractionConfig' : 'setExtractionOptions';
                this.mp4boxfile[m](track.id, null, { nb_samples: 1 });
            };
            this.mp4boxfile.onSamples = (id, user, samples) => {
                for (const sample of samples) {
                    if (!this.isConfigured) this.pendingSamples.push(sample);
                    else this.sendSample(sample);
                }
            };
            
            const response = await fetch(info.video.url_path);
            const totalBytes = parseInt(response.headers.get('content-length') || '0');
            const reader = response.body.getReader();
            let offset = 0;
            const bufferBar = document.getElementById(`progress-buffer-${this.id}`);

            const pump = async () => {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        this.mp4boxfile.flush();
                        if (this._unifiedAv) this._finalizeMseOnPumpDone();
                        break;
                    }
                    const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
                    buf.fileStart = offset;
                    offset += buf.byteLength;
                    this.mp4boxfile.appendBuffer(buf);
                    if (this._unifiedAv) this._queueMseBytesFromReadable(value);

                    if (totalBytes > 0 && bufferBar) {
                        const pct = (offset / totalBytes) * 100;
                        bufferBar.style.width = `${pct}%`;
                    } else if (bufferBar) {
                        const pseudoPct = Math.min(99, (offset / 10_000_000) * 100); 
                        bufferBar.style.width = `${pseudoPct}%`;
                    }

                    /* ASLA burada frameQueue'ya gore fetch'i uyutmayin:
                     * Aynı akista MSE + MP4Box varken ag durunca ses tamponundan oynamaya devam eder,
                     * goruntu ise byte gelmedigi icin kesilir (canli/Tesla'da sık görulur).
                     * Kuyruk sınırını yalnizca onFrame'de VideoFrame kapatarak yönet. */
                }
            };
            pump().catch((e) => {
                this._spinnerUntilPrimed = false;
                this._syncStageOverlay();
                log('error', this.id, e.message);
            });
        } catch (e) {
            this._spinnerUntilPrimed = false;
            this._syncStageOverlay();
            log('error', this.id, e.message);
        }
    },

    sendSample(sample) {
        if (!this.decoder || this.decoder.state !== 'configured') return;
        try {
            const tsUs = Math.round((sample.cts / this.timescale) * 1_000_000);
            this.decoder.decode(new EncodedVideoChunk({
                type: sample.is_sync ? 'key' : 'delta',
                timestamp: tsUs,
                duration: Math.round((sample.duration / this.timescale) * 1_000_000),
                data: this.isAVCC ? sample.data : this.toAnnexB(sample.data)
            }));
        } catch(e) {}
    },

    onFrame(frame) {
        this.frameQueue.push(frame);

        // Pause iken frame'leri tamamen atma: küçük bir buffer tut ki resume anında anında başlayabilsin.
        if (!this.isPlaying) {
            while (this.frameQueue.length > this.MAX_BUFFER) {
                const f = this.frameQueue.shift();
                try { f.close(); } catch (e) {}
            }
            return;
        }

        while (this.frameQueue.length > this.MAX_BUFFER) {
            const f = this.frameQueue.shift();
            try { f.close(); } catch (e) {}
        }

        const bufPrimed = DIAG_BYPASS_PAUSE_RESUME ? 1 : this.MIN_BUFFER;
        if (this.isBuffering && this.frameQueue.length >= bufPrimed) {
            this._finalizeBufferAndStartSynced();
        }
    },

    _finalizeBufferAndStartSynced() {
        if (this.frameQueue.length === 0 || !this.isPlaying) return;
        this.isBuffering = false;
        const frameTs = this.frameQueue[0].timestamp / 1_000_000;
        const hadResumeClamp = typeof this._syncAudioCeilSec === 'number' && typeof this._syncAudioFloorSec === 'number';
        const syncT = this._computeResumeAudioSyncTime(frameTs);
        if (!this.firstFrameSeen) {
            try { this.audio.currentTime = syncT; } catch (e) {}
            this.firstFrameSeen = true;
        } else if (this._needResyncOnPlay) {
            const drift = Math.abs((this.audio.currentTime || 0) - syncT);
            if (drift > 0.25) {
                try { this.audio.currentTime = syncT; } catch (e) {}
            }
        }
        this._syncAudioFloorSec = null;
        this._syncAudioCeilSec = null;
        if (hadResumeClamp) this.pauseBookmarkSec = 0;
        this._needResyncOnPlay = false;
        this._presentHeadFrameBeforeAudio();
        this._safeAudioPlay();
        this._spinnerUntilPrimed = false;
        this._updateProgress();
        this._syncStageOverlay();
    },

    _fitCanvasToFrame(frame) {
        const w = frame.displayWidth;
        const h = frame.displayHeight;
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
    },

    _presentHeadFrameBeforeAudio() {
        if (this.frameQueue.length === 0) return;
        const frame = this.frameQueue.shift();
        try {
            this._fitCanvasToFrame(frame);
            this.ctx.drawImage(frame, 0, 0);
            this.frameCount++;
            this._markSurfacePainted();
        } catch (e) {
            log('warn', this.id, `Ilk kare cizilemedi: ${e?.message || e}`);
        } finally {
            try { frame.close(); } catch (e2) {}
        }
    },

    _safeAudioPlay() {
        // Tesla'da pause→play bazen "çalıştı" gibi görünüp time hiç ilerlemeyebiliyor.
        // Bu watchdog, kısa süre içinde ilerleme yoksa audio'yu reload ederek toparlar.
        const startT = this.audio.currentTime || 0;
        this.audio.play().catch(() => {
            try { this.audio.load(); } catch (e) {}
            this.audio.play().catch(() => {});
        });

        if (this._resumeWatchdog) clearTimeout(this._resumeWatchdog);
        this._resumeWatchdog = setTimeout(() => {
            if (!this.isPlaying) return;
            const nowT = this.audio.currentTime || 0;
            if (nowT <= startT + 0.02) {
                try {
                    const t = this.pausedAtSec || startT;
                    const src = this.audio.src;
                    this.audio.pause();
                    this.audio.src = src;
                    this.audio.load();
                    this.audio.currentTime = t;
                    this.audio.play().catch(() => {});
                } catch (e) {}
            }
        }, 900);
    },

    _startPlaybackLoop() {
        const currentGen = this.renderGen;
        /** Ses raporu ile decode kuyrugu zamanı ayrılınca ilk kare yakılır ses ileriye gider; MSE'de seek bu rAF içinde hep yansımayabilir. */
        const WIN = 0.28;
        const AHEAD = 0.32;

        const loop = () => {
            if (currentGen !== this.renderGen || !this.isPlaying) return;

            if (!this.isBuffering && this.frameQueue.length > 0) {
                const headTs = this.frameQueue[0].timestamp / 1_000_000;
                let masterTs = this.audio.currentTime || 0;

                if (masterTs > headTs + AHEAD) {
                    try {
                        this.audio.currentTime = Math.max(0, headTs - 0.05);
                    } catch (e) {}
                    const after = this.audio.currentTime || 0;
                    /* Hâlâ ileriyse seçim için saati görüntüye kilitle — aksi halde kare yakma döngüsü devam eder */
                    masterTs = after > headTs + AHEAD ? headTs : after;
                }

                while (this.frameQueue.length > 0) {
                    const frame = this.frameQueue[0];
                    const frameTs = frame.timestamp / 1_000_000;

                    if (this.frameQueue.length > 1 && frameTs < masterTs - WIN) {
                        this.frameQueue.shift().close();
                        continue;
                    }
                    if (frameTs <= masterTs + WIN) {
                        this._fitCanvasToFrame(frame);
                        this.ctx.drawImage(frame, 0, 0);
                        this.frameQueue.shift().close();
                        this.frameCount++;
                        this._markSurfacePainted();
                        break;
                    }
                    break;
                }
            }

            if (!this.isBuffering && this.frameQueue.length === 0 && this.isPlaying) {
                if (!this.audio.ended && this.audio.readyState > 2) {
                   this.isBuffering = true;
                   this.audio.pause();
                }
            }

            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    },

    toAnnexB(data) {
        const src = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer || data);
        const dst = new Uint8Array(src.length);
        dst.set(src);
        let i = 0;
        while (i + 4 < dst.length) {
            const len = (dst[i] << 24) | (dst[i+1] << 16) | (dst[i+2] << 8) | dst[i+3];
            if (len <= 0 || i + 4 + len > dst.length) break;
            dst[i] = 0; dst[i+1] = 0; dst[i+2] = 0; dst[i+3] = 1;
            i += 4 + len;
        }
        return dst;
    },

    getAVCCFromMP4Box(track) {
        try {
            const trak = this.mp4boxfile.getTrackById?.(track.id);
            if (trak) {
                const avcC = trak.mdia?.minf?.stbl?.stsd?.entries?.[0]?.avcC;
                if (avcC) {
                    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                    avcC.write(stream);
                    return new Uint8Array(stream.buffer, 8);
                }
            }
            return null;
        } catch(e) { return null; }
    }
};
