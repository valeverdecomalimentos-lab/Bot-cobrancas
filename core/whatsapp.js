const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrweb = require('./qrweb');

let client;
let ready = false;
let onReadyCallback = null;

module.exports = {
    iniciar: async () => {
        client = new Client({
            authStrategy: new LocalAuth({ clientId: "valeverde" }),
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

        client.on('auth_failure', () => {
            console.error('Falha na autenticação do WhatsApp.');
        });

        await client.initialize();
    },
    isReady: () => ready,
    getClient: () => client,
    onReady: (cb) => onReadyCallback = cb
};