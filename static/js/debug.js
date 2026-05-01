export function log(level, source, message) {
    const now = new Date();
    const ts = now.toLocaleTimeString() + '.' + String(now.getMilliseconds()).padStart(3, '0');
    
    // Konsol logu (F12 için)
    const styles = {
        info: 'color: #00e5ff',
        warn: 'color: #ffcc00',
        error: 'color: #ff3333; font-weight: bold',
        success: 'color: #00ff88; font-weight: bold'
    };
    console.log(`%c[${ts}] [${source.toUpperCase()}] ${message}`, styles[level] || '');

    const logContainer = document.getElementById('debug-log');
    if (logContainer) {
        const div = document.createElement('div');
        div.className = `log-entry ${level}`;
        div.innerHTML = `
            <span class="log-ts">${ts}</span>
            <span class="log-src" style="min-width: 60px; display: inline-block;">[${source}]</span>
            <span class="log-msg">${message}</span>
        `;
        logContainer.appendChild(div);
        
        // Sınır koyalım (performans için son 200 log)
        if (logContainer.childNodes.length > 200) {
            logContainer.removeChild(logContainer.firstChild);
        }

        if (document.getElementById('auto-scroll')?.checked) {
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }
}

export function setLED(techId, ledType, color) {
    const led = document.querySelector(`#panel-${techId} [data-led="${ledType}"]`);
    if (led) {
        led.style.backgroundColor = color === 'green' ? '#00ff88' : color === 'red' ? '#ff3333' : color === 'yellow' ? '#ffcc00' : '#333';
        led.style.boxShadow = (color === 'green' || color === 'red' || color === 'yellow') ? `0 0 8px ${color === 'green' ? '#00ff88' : color === 'red' ? '#ff3333' : '#ffcc00'}` : 'none';
    }
}

window.onerror = function(msg, url, line, col, error) {
    log('error', 'system', `${msg} (Satır: ${line})`);
};

document.getElementById('clear-log')?.addEventListener('click', () => {
    const logContainer = document.getElementById('debug-log');
    if (logContainer) logContainer.innerHTML = '';
});
