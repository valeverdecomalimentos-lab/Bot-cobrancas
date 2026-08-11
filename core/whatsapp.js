const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

const AUTH_ID = 'valeverde-app';
const AUTH_DIR = process.env.VALEVERDE_AUTH_DIR || path.join(__dirname, '..', '.wwebjs_auth');

let client;
let ready = false;
let startingPromise = null;
let qrAtual = null;
let qrDataUrl = null;
let numeroConectado = null;
let onReadyCallback = null;
const events = new EventEmitter();

function currentStatus() {
    if (ready) return 'conectado';
    if (qrAtual) return 'aguardando_qr';
    if (startingPromise) return 'iniciando';
    return 'desconectado';
}

function statusPayload(extra = {}) {
    return {
        status: currentStatus(),
        numero: numeroConectado,
        qrUrl: null,
        qrDataUrl,
        ...extra,
    };
}

function emitStatus(extra) {
    events.emit('status', statusPayload(extra));
}

async function iniciar() {
    if (ready && client) return client;
    if (startingPromise) return startingPromise;

    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    client = new Client({
        authStrategy: new LocalAuth({ clientId: AUTH_ID, dataPath: AUTH_DIR }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    });

    client.on('qr', async (qr) => {
        qrAtual = qr;
        qrDataUrl = null;
        ready = false;
        console.log('\n\n======================================');
        console.log('Escaneie o QRCode abaixo para conectar:');
        console.log('======================================\n');
        qrcode.generate(qr, { small: true });

        try {
            qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
            events.emit('qr', { qrDataUrl });
            emitStatus();
        } catch (err) {
            events.emit('error', err);
        }
    });

    client.on('ready', () => {
        ready = true;
        qrAtual = null;
        qrDataUrl = null;
        numeroConectado = client.info?.wid?.user ? `+${client.info.wid.user}` : null;
        emitStatus();
        if (onReadyCallback) onReadyCallback();
    });

    client.on('auth_failure', (msg) => {
        ready = false;
        qrAtual = null;
        qrDataUrl = null;
        emitStatus({ erro: msg || 'Falha na autenticacao do WhatsApp.' });
    });

    client.on('disconnected', (reason) => {
        ready = false;
        qrAtual = null;
        qrDataUrl = null;
        numeroConectado = null;
        startingPromise = null;
        emitStatus({ erro: reason || 'WhatsApp desconectado.' });
    });

    startingPromise = client.initialize()
        .then(() => client)
        .catch((error) => {
            ready = false;
            qrAtual = null;
            qrDataUrl = null;
            startingPromise = null;
            emitStatus({ erro: error.message });
            throw error;
        });

    emitStatus();
    return startingPromise;
}

module.exports = {
    iniciar,
    isReady: () => ready,
    getClient: () => client,
    getStatus: () => statusPayload(),
    onReady: (cb) => { onReadyCallback = cb; },
    on: (eventName, cb) => {
        events.on(eventName, cb);
        return () => events.off(eventName, cb);
    },
};
