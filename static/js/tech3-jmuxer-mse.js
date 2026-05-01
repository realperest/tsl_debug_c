import { log, setLED } from './debug.js';

export const TechModule = {
    id: 'tech3',
    name: 'jmuxer + MSE (Kontrol)',
    video: null,

    init(panel) {
        this.video = panel.querySelector('video');
        if (this.video) {
            // Sesi kullanıcı istediği için sessiz moddan çıkarıyoruz
            this.video.muted = false; 
            this.video.playsInline = true;
            this.video.volume = 1.0;
        }
    },

    play() {
        if (this.video) {
            log('info', this.id, 'Oynat komutu gönderildi (Ses açık)');
            this.video.play().catch(e => {
                log('warn', this.id, `Sesli oynatma engellenmiş olabilir, lütfen ekrana bir kez tıklayın ve tekrar deneyin.`);
                // Fallback: Sessiz oynatmayı dene
                this.video.muted = true;
                this.video.play();
            });
        }
    },

    pause() { if (this.video) this.video.pause(); },

    reset() {
        if (this.video) {
            this.video.pause();
            this.video.src = '';
            this.video.load();
        }
    },

    async load(token, info) {
        log('info', this.id, 'Video kaynağı yükleniyor...');
        setLED(this.id, 'load', 'yellow');
        this.reset();
        try {
            this.video.src = info.video.url_path;
            this.video.oncanplay = () => {
                log('info', this.id, 'Hazır ✅');
                setLED(this.id, 'load', 'green');
                setLED(this.id, 'decode', 'green');
                setLED(this.id, 'render', 'green');
            };
            this.video.onerror = () => {
                log('error', this.id, `Video yüklenemedi!`);
                setLED(this.id, 'load', 'red');
            };
            this.video.load();
        } catch (e) { log('error', this.id, e.message); }
    }
};
