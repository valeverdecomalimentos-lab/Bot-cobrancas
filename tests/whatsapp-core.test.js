const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const whatsapp = require('../core/whatsapp');

test('timeout de inicializacao do WhatsApp e configuravel e tem limite minimo seguro', () => {
    const { initializationTimeoutMs } = whatsapp._internals;
    assert.equal(initializationTimeoutMs({}), 60_000);
    assert.equal(initializationTimeoutMs({ WHATSAPP_INIT_TIMEOUT_MS: '25000' }), 25_000);
    assert.equal(initializationTimeoutMs({ WHATSAPP_INIT_TIMEOUT_MS: '20' }), 1_000);
    assert.equal(initializationTimeoutMs({ WHATSAPP_INIT_TIMEOUT_MS: 'invalido' }), 60_000);
});

test('navegador configurado tem prioridade sobre descoberta automatica', () => {
    const configured = path.resolve('fixtures', 'chrome-test.exe');
    const executable = whatsapp._internals.resolveBrowserExecutable({
        env: { WHATSAPP_CHROME_PATH: configured },
        platform: 'win32',
        exists: (candidate) => candidate === configured,
        puppeteerApi: { executablePath: () => path.resolve('cache', 'chrome.exe') },
    });
    assert.equal(executable, configured);
});

test('cache do Puppeteer e usado somente depois dos navegadores do sistema', () => {
    const cached = path.resolve('cache', 'puppeteer', 'chrome.exe');
    const executable = whatsapp._internals.resolveBrowserExecutable({
        env: {},
        platform: 'linux',
        exists: (candidate) => candidate === cached,
        puppeteerApi: { executablePath: () => cached },
    });
    assert.equal(executable, cached);
});

test('diretorio removivel e exclusivamente a sessao esperada dentro do AUTH_DIR', () => {
    const target = whatsapp._internals.sessionDirectory();
    assert.equal(path.dirname(target), whatsapp._internals.AUTH_DIR);
    assert.equal(path.basename(target), whatsapp._internals.SESSION_DIR_NAME);
    assert.equal(path.basename(target), 'session-valeverde-app');
});
