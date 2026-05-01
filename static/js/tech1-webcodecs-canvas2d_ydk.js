import { log, setLED } from './debug.js';

export const TechModule = {
    id: 'tech1',
    name: 'WebCodecs + Canvas 2D',
    canvas: null,
    ctx: null,
    audio: null,
    decoder: null,
    mp4boxfile: null,
    frameCount: 0,
    firstFrameSeen: false,
    startTime: 0,
    isPlaying: false,
    isConfigured: false,
    isAVCC: false,
    timescale: 90000,
    pendingSamples: [],

    init(panel) {
        this.canvas = panel.querySelector('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.audio = new Audio();
        this.audio.volume = 1.0;
    },

    play() {
        if (!this.isPlaying) {
            log('info', this.id, '▶️ Oynatılıyor...');
            this.isPlaying = true;
            // audio.play() ilk frame seek sonrasında çağrılacak
            if (this.mp4boxfile) this.mp4boxfile.start();
        }
    },

    pause() {
        this.isPlaying = false;
        this.audio.pause();
        if (this.mp4boxfile) this.mp4boxfile.stop();
    },

    reset() {
        this.isPlaying = false;
        this.isConfigured = false;
        this.isAVCC = false;
        this.firstFrameSeen = false;
        this.pendingSamples = [];
        this.frameCount = 0;
        this.timescale = 90000;
        this.audio.pause();
        this.audio.src = '';
        if (this.decoder) { try { this.decoder.close(); } catch(e) {} this.decoder = null; }
        if (this.mp4boxfile) { try { this.mp4boxfile.flush(); } catch(e) {} this.mp4boxfile = null; }
    },

    async load(token, info) {
        const self = this;
        log('info', self.id, '📥 Yükleme başladı...');
        setLED(self.id, 'load', 'yellow');
        self.reset();

        // Ses kaynağını bağla
        if (info.audio && info.audio.url_path) {
            self.audio.src = info.audio.url_path;
            self.audio.load();
        }

        try {
            self.mp4boxfile = MP4Box.createFile();

            self.mp4boxfile.onReady = (readyInfo) => {
                const track = readyInfo.videoTracks[0];
                if (!track) { log('error', self.id, 'Video track bulunamadı.'); return; }

                self.timescale = track.timescale || 90000;
                log('info', self.id, `Track: ${track.codec} | ${track.track_width}x${track.track_height} | Timescale: ${self.timescale}`);

                const avcCDesc = self.getAVCCFromMP4Box(track);
                const config = {
                    codec: track.codec,
                    codedWidth: track.track_width,
                    codedHeight: track.track_height,
                };

                if (avcCDesc && avcCDesc.byteLength > 4) {
                    config.description = avcCDesc;
                    self.isAVCC = true;
                    log('info', self.id, `AVCC modu: ${avcCDesc.byteLength} byte`);
                } else {
                    self.isAVCC = false;
                    log('warn', self.id, 'AVCC yok, AnnexB modu.');
                }

                self.decoder = new VideoDecoder({
                    output: (frame) => self.render(frame),
                    error: (e) => log('error', self.id, `Decoder: ${e.message}`)
                });

                try {
                    self.decoder.configure(config);
                    self.isConfigured = true;
                    log('success', self.id, 'Decoder Aktif ✅');
                    setLED(self.id, 'decode', 'green');
                    setLED(self.id, 'render', 'green'); // Decoder hazır, direkt yeşil

                    for (const s of self.pendingSamples) self.sendSample(s);
                    self.pendingSamples = [];
                } catch (e) {
                    log('error', self.id, `Decoder configure hatası: ${e.message}`);
                }

                try {
                    const m = self.mp4boxfile.setExtractionConfig ? 'setExtractionConfig' : 'setExtractionOptions';
                    self.mp4boxfile[m](track.id, null, { nb_samples: 1 });
                } catch(e) {}
                setLED(self.id, 'load', 'green');
            };

            self.mp4boxfile.onSamples = (id, user, samples) => {
                for (const sample of samples) {
                    if (!self.isConfigured) {
                        self.pendingSamples.push(sample);
                    } else {
                        self.sendSample(sample);
                    }
                }
            };

            const response = await fetch(info.video.url_path);
            const reader = response.body.getReader();
            let offset = 0;
            const process = async () => {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) { self.mp4boxfile.flush(); break; }
                    const buffer = value.buffer;
                    buffer.fileStart = offset;
                    offset += buffer.byteLength;
                    self.mp4boxfile.appendBuffer(buffer);
                }
            };
            process().catch(e => log('error', self.id, e.message));

        } catch (e) { log('error', self.id, e.message); }
    },

    sendSample(sample) {
        if (!this.decoder || this.decoder.state !== 'configured') return;
        try {
            const tsUs = Math.round((sample.cts / this.timescale) * 1_000_000);
            const durUs = Math.round((sample.duration / this.timescale) * 1_000_000);
            const chunk = new EncodedVideoChunk({
                type: sample.is_sync ? 'key' : 'delta',
                timestamp: tsUs,
                duration: durUs,
                data: this.isAVCC ? sample.data : this.toAnnexB(sample.data)
            });
            this.decoder.decode(chunk);
        } catch(e) {}
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
            const trak = this.mp4boxfile.getTrackById ? this.mp4boxfile.getTrackById(track.id) : null;
            if (trak) {
                const stsd = trak.mdia?.minf?.stbl?.stsd;
                if (stsd?.entries?.length > 0) {
                    const avcC = stsd.entries[0].avcC;
                    if (avcC) {
                        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                        avcC.write(stream);
                        return new Uint8Array(stream.buffer, 8);
                    }
                }
            }
            return null;
        } catch (e) { return null; }
    },

    render(frame) {
        if (!this.firstFrameSeen) {
            this.firstFrameSeen = true;
            const frameTsMs = frame.timestamp / 1000; // µs → ms
            // startTime'ı frame timestamp'ına göre geriye al
            // böylece elapsed = frameTsSec'ten başlar
            this.startTime = performance.now() - frameTsMs;
            // Sesi video frame pozisyonuna seek et (senkronizasyon)
            if (this.audio && this.audio.src) {
                this.audio.currentTime = frame.timestamp / 1_000_000;
                this.audio.play().catch(() => {});
            }
            log('success', this.id, `🎬 GÖRÜNTÜ BAŞLADI! (t=${(frame.timestamp/1_000_000).toFixed(2)}s)`);
            setLED(this.id, 'render', 'green');
        }

        if (!this.isPlaying) { frame.close(); return; }

        const frameTsSec = frame.timestamp / 1_000_000;
        const elapsed = (performance.now() - this.startTime) / 1000;
        const drift = frameTsSec - elapsed;

        const doRender = () => {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
            this.ctx.drawImage(frame, 0, 0);
            frame.close();
            this.frameCount++;
            if (this.frameCount % 60 === 0) {
                const e = (performance.now() - this.startTime) / 1000;
                const fps = e > 0 ? (this.frameCount / e).toFixed(1) : '0';
                const el = document.getElementById(`fps-${this.id}`);
                if (el) el.textContent = fps;
            }
        };

        if (drift > 0.02) {
            setTimeout(doRender, drift * 1000);
        } else {
            doRender();
        }
    }
};
