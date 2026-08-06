const http = require('http');
const { spawn } = require('child_process');

let server = null;
let currentQr = null;
let browserOpened = false;
let port = 3000;

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildHtml(qrValue) {
    const qr = qrValue ? escapeHtml(qrValue) : '';
    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vale Verde Bot - QR Code WhatsApp</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f5f7fb; color: #222; margin: 0; padding: 24px; }
    .card { max-width: 520px; margin: 40px auto; background: white; border-radius: 16px; padding: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.08); }
    h1 { font-size: 22px; margin-top: 0; }
    p { color: #555; line-height: 1.5; }
    .qr-box { margin-top: 16px; padding: 12px; border: 1px solid #ddd; border-radius: 12px; background: #fff; text-align: center; }
    .qr-box canvas, .qr-box img { max-width: 100%; }
    .hint { font-size: 13px; color: #777; margin-top: 8px; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Conecte o WhatsApp</h1>
    <p>Escaneie o QR Code abaixo com o WhatsApp no seu celular.</p>
    <div class="qr-box">
      <canvas id="qr-canvas"></canvas>
      <div id="qr-placeholder">Aguardando QR Code...</div>
    </div>
    <p class="hint">Se o QR não aparecer, aguarde alguns segundos ou reinicie o bot.</p>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
  <script>
    const qrValue = ${JSON.stringify(qr)};
    const canvas = document.getElementById('qr-canvas');
    const placeholder = document.getElementById('qr-placeholder');
    if (!qrValue) {
      placeholder.textContent = 'Aguardando QR Code...';
    } else {
      placeholder.style.display = 'none';
      QRCode.toCanvas(canvas, qrValue, { width: 280, margin: 1 }, function (error) {
        if (error) {
          placeholder.style.display = 'block';
          placeholder.textContent = 'Não foi possível renderizar o QR Code.';
        }
      });
    }
  </script>
</body>
</html>`;
}

function startServer(options = {}) {
    if (server) {
        return Promise.resolve(server);
    }

    const selectedPort = options.port || port;

    return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
            if (req.url === '/qr' || req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(buildHtml(currentQr));
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not found');
            }
        });

        server.on('error', reject);
        server.listen(selectedPort, '127.0.0.1', () => {
            port = selectedPort;
            resolve(server);
            console.log(`\nPágina QR disponível em http://127.0.0.1:${selectedPort}/qr`);
        });
    });
}

function setQr(value) {
    currentQr = value;
}

function openBrowser(url) {
    if (browserOpened) {
        return;
    }

    browserOpened = true;
    const target = url || `http://127.0.0.1:${port}/qr`;

    try {
        if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore', detached: true });
        } else if (process.platform === 'darwin') {
            spawn('open', [target], { stdio: 'ignore', detached: true });
        } else {
            spawn('xdg-open', [target], { stdio: 'ignore', detached: true });
        }
    } catch (err) {
        // Ignora erro de abrir o navegador automaticamente.
    }
}

module.exports = {
    startServer,
    setQr,
    openBrowser
};
