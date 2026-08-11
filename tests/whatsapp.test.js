const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const EventEmitter = require('node:events');
const test = require('node:test');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function nextTurn() {
    return new Promise((resolve) => setImmediate(resolve));
}

function loadWhatsapp({ qrError = null } = {}) {
    const modulePath = require.resolve('../core/whatsapp');
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-whatsapp-test-'));
    const fakeBrowser = path.join(authDir, 'fake-browser.exe');
    fs.writeFileSync(fakeBrowser, 'browser falso usado apenas pelo teste', 'utf8');
    const previousAuthDir = process.env.VALEVERDE_AUTH_DIR;
    const previousBrowserPath = process.env.WHATSAPP_CHROME_PATH;
    process.env.VALEVERDE_AUTH_DIR = authDir;
    process.env.WHATSAPP_CHROME_PATH = fakeBrowser;

    const clients = [];
    const terminalQrs = [];
    const qrCalls = [];

    class FakeLocalAuth {
        constructor(options) {
            this.options = options;
        }
    }

    class FakeClient extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.info = null;
            this.initialization = deferred();
            this.initializeCalls = 0;
            this.destroyCalls = 0;
            this.logoutCalls = 0;
            clients.push(this);
        }

        initialize() {
            this.initializeCalls += 1;
            return this.initialization.promise;
        }

        async destroy() {
            this.destroyCalls += 1;
        }

        async logout() {
            this.logoutCalls += 1;
        }
    }

    const fakeModules = {
        'whatsapp-web.js': { Client: FakeClient, LocalAuth: FakeLocalAuth },
        'qrcode-terminal': { generate: (value, options) => terminalQrs.push({ value, options }) },
        qrcode: {
            async toDataURL(value, options) {
                qrCalls.push({ value, options });
                if (qrError) throw qrError;
                return 'data:image/png;base64,dGVzdGUtcXItc2VndXJv';
            },
        },
    };

    const originalLoad = Module._load;
    Module._load = function mockDependency(request, parent, isMain) {
        if (Object.hasOwn(fakeModules, request)) return fakeModules[request];
        return originalLoad.call(this, request, parent, isMain);
    };

    let whatsapp;
    try {
        delete require.cache[modulePath];
        whatsapp = require(modulePath);
    } finally {
        Module._load = originalLoad;
    }

    return {
        whatsapp,
        clients,
        terminalQrs,
        qrCalls,
        cleanup() {
            delete require.cache[modulePath];
            if (previousAuthDir === undefined) delete process.env.VALEVERDE_AUTH_DIR;
            else process.env.VALEVERDE_AUTH_DIR = previousAuthDir;
            if (previousBrowserPath === undefined) delete process.env.WHATSAPP_CHROME_PATH;
            else process.env.WHATSAPP_CHROME_PATH = previousBrowserPath;
            fs.rmSync(authDir, { recursive: true, force: true });
        },
    };
}

test('mantem um unico cliente e percorre os estados do QR sem Chromium real', { concurrency: false }, async (context) => {
    const fixture = loadWhatsapp();
    context.after(async () => {
        await fixture.whatsapp.encerrar();
        fixture.cleanup();
    });
    const statuses = [];
    fixture.whatsapp.on('status', (status) => statuses.push(status));

    const firstStart = fixture.whatsapp.iniciar();
    const repeatedStart = fixture.whatsapp.iniciar();
    await nextTurn();

    assert.equal(fixture.clients.length, 1);
    assert.equal(fixture.clients[0].initializeCalls, 1);
    assert.equal(fixture.whatsapp.getStatus().status, 'iniciando');

    fixture.clients[0].emit('qr', 'qr-bruto-isolado');
    await nextTurn();

    assert.deepEqual(fixture.terminalQrs, [{ value: 'qr-bruto-isolado', options: { small: true } }]);
    assert.deepEqual(fixture.qrCalls, [{ value: 'qr-bruto-isolado', options: { width: 280, margin: 1 } }]);
    assert.equal(fixture.whatsapp.getStatus().status, 'aguardando_qr');
    assert.match(fixture.whatsapp.getStatus().qrDataUrl, /^data:image\/png;base64,/);
    assert.equal(statuses.at(-1).status, 'aguardando_qr');

    fixture.clients[0].info = { wid: { user: '5511999999999' } };
    fixture.clients[0].emit('ready');
    await Promise.all([firstStart, repeatedStart]);

    assert.equal(fixture.whatsapp.isReady(), true);
    assert.deepEqual(fixture.whatsapp.getStatus(), {
        status: 'conectado',
        numero: '+5511999999999',
        qrUrl: null,
        qrDataUrl: null,
        erro: null,
    });

    fixture.clients[0].emit('disconnected', 'Conexao encerrada no teste');
    assert.equal(fixture.whatsapp.isReady(), false);
    assert.equal(fixture.whatsapp.getStatus().status, 'desconectado');
    assert.equal(statuses.at(-1).erro, 'Conexao encerrada no teste');
});

test('publica erro de conversao do QR sem emitir EventEmitter error sem ouvinte', { concurrency: false }, async (context) => {
    const qrError = new Error('Falha simulada ao converter QR');
    const fixture = loadWhatsapp({ qrError });
    context.after(async () => {
        await fixture.whatsapp.encerrar();
        fixture.cleanup();
    });
    const statuses = [];
    fixture.whatsapp.on('status', (status) => statuses.push(status));

    const start = fixture.whatsapp.iniciar();
    await nextTurn();
    fixture.clients[0].emit('qr', 'qr-com-falha');
    await nextTurn();
    await start;

    assert.equal(statuses.at(-1).status, 'aguardando_qr');
    assert.equal(statuses.at(-1).qrDataUrl, null);
    assert.equal(statuses.at(-1).erro, qrError.message);

    fixture.clients[0].initialization.reject(new Error('Inicializacao encerrada no teste'));
    await nextTurn();
    assert.equal(fixture.whatsapp.getStatus().status, 'desconectado');
    assert.equal(fixture.whatsapp.getStatus().erro, 'Inicializacao encerrada no teste');
});

test('reset remove somente a sessao esperada e prepara um novo cliente', { concurrency: false }, async (context) => {
    const fixture = loadWhatsapp();
    context.after(async () => {
        await fixture.whatsapp.encerrar();
        fixture.cleanup();
    });

    const sessionDirectory = fixture.whatsapp._internals.sessionDirectory();
    const siblingDirectory = path.join(fixture.whatsapp._internals.AUTH_DIR, 'nao-remover');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.mkdirSync(siblingDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessionDirectory, 'credencial-falsa.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(siblingDirectory, 'preservar.txt'), 'preservado', 'utf8');

    const start = fixture.whatsapp.iniciar();
    await nextTurn();
    fixture.clients[0].emit('qr', 'qr-antes-do-reset');
    await start;

    const resetStatus = await fixture.whatsapp.resetar();
    await nextTurn();

    assert.equal(fs.existsSync(sessionDirectory), false);
    assert.equal(fs.existsSync(path.join(siblingDirectory, 'preservar.txt')), true);
    assert.equal(fixture.clients[0].destroyCalls, 1);
    assert.equal(fixture.clients.length, 2);
    assert.equal(fixture.clients[1].initializeCalls, 1);
    assert.equal(resetStatus.erro, null);
    assert.ok(['desconectado', 'iniciando'].includes(resetStatus.status));
});
