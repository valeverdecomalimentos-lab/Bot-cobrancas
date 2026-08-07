const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrweb = require('./qrweb');

const AUTH_ID = 'valeverde-app';
const AUTH_DIR = path.join(__dirname, '..', '.wwebjs_auth');
let client;
let ready = false;
let onReadyCallback = null;

module.exports = {
    iniciar: async () => {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        client = new Client({
            authStrategy: new LocalAuth({ clientId: AUTH_ID, dataPath: AUTH_DIR }),
            puppeteer: {
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        client.on('qr', async (qr) => {
            console.log('\n\n======================================');
            console.log('Escaneie o QRCode abaixo para conectar:');
            console.log('======================================\n');
            qrcode.generate(qr, { small: true });

            try {
                qrweb.setQr(qr);
                await qrweb.startServer();
                qrweb.openBrowser();
            } catch (err) {
                console.log('Não foi possível abrir a página web do QR Code:', err.message);
            }
        });

        client.on('ready', () => {
            ready = true;
            if(onReadyCallback) onReadyCallback();
        });

        client.on('auth_failure', (msg) => {
            console.error('Falha na autenticação do WhatsApp:', msg || 'sem mensagem');
        });

        client.on('disconnected', (reason) => {
            console.error('WhatsApp desconectado:', reason);
        });

        await client.initialize();
    },
    isReady: () => ready,
    getClient: () => client,
    onReady: (cb) => onReadyCallback = cb
};