const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

const AUTH_ID = 'valeverde-app';
const SESSION_DIR_NAME = `session-${AUTH_ID}`;
const AUTH_DIR = path.resolve(process.env.VALEVERDE_AUTH_DIR || path.join(__dirname, '..', '.wwebjs_auth'));
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 60_000;
const DESTROY_TIMEOUT_MS = 10_000;

let client = null;
let ready = false;
let connectionState = 'desconectado';
let startingPromise = null;
let activeAttempt = null;
let cleanupPromise = Promise.resolve();
let resetPromise = null;
let shuttingDown = false;
let lifecycleId = 0;
let qrAtual = null;
let qrDataUrl = null;
let numeroConectado = null;
let ultimoErro = null;
let onReadyCallback = null;
let qrConsoleTimer = null;
let qrConsoleSequence = 0;
const destroyingClients = new WeakSet();
const events = new EventEmitter();

function errorMessage(error, fallback = 'Falha ao iniciar o WhatsApp.') {
    const message = String(error?.message || error || fallback).trim();
    return message || fallback;
}

function initializationTimeoutMs(env = process.env) {
    const configured = Number(env.WHATSAPP_INIT_TIMEOUT_MS || env.VALEVERDE_WHATSAPP_INIT_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0
        ? Math.max(1_000, Math.round(configured))
        : DEFAULT_INITIALIZATION_TIMEOUT_MS;
}

function existingFile(candidate, exists = fs.existsSync) {
    if (!candidate) return null;
    const normalized = String(candidate).trim().replace(/^['"]|['"]$/g, '');
    if (!normalized) return null;
    const resolved = path.resolve(normalized);
    try {
        return exists(resolved) ? resolved : null;
    } catch {
        return null;
    }
}

function systemBrowserCandidates(env = process.env, platform = process.platform) {
    if (platform === 'win32') {
        return [
            env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
            env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ].filter(Boolean);
    }
    if (platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ];
    }
    return [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ];
}

function resolveBrowserExecutable({
    env = process.env,
    platform = process.platform,
    exists = fs.existsSync,
    puppeteerApi,
} = {}) {
    const candidates = [
        env.WHATSAPP_CHROME_PATH,
        env.PUPPETEER_EXECUTABLE_PATH,
        ...systemBrowserCandidates(env, platform),
    ];
    for (const candidate of candidates) {
        const executable = existingFile(candidate, exists);
        if (executable) return executable;
    }

    try {
        const puppeteer = puppeteerApi || require('puppeteer');
        const executable = existingFile(puppeteer.executablePath(), exists);
        if (executable) return executable;
    } catch {
        // O erro amigavel e emitido abaixo, junto ao status persistente.
    }

    throw new Error(
        'Chrome ou Edge nao encontrado. Instale um navegador compativel ou configure WHATSAPP_CHROME_PATH.',
    );
}

function sessionDirectory() {
    const root = path.resolve(AUTH_DIR);
    const target = path.resolve(root, SESSION_DIR_NAME);
    const relative = path.relative(root, target);
    if (relative !== SESSION_DIR_NAME || path.dirname(target) !== root) {
        throw new Error('Diretorio de autenticacao do WhatsApp invalido.');
    }
    return target;
}

function currentStatus() {
    return connectionState;
}

function statusPayload(extra = {}) {
    return {
        status: currentStatus(),
        numero: numeroConectado,
        qrUrl: null,
        qrDataUrl,
        erro: ultimoErro,
        ...extra,
    };
}

function emitStatus(extra) {
    events.emit('status', statusPayload(extra));
}

function clearConsoleQrTimer() {
    if (qrConsoleTimer) {
        clearTimeout(qrConsoleTimer);
        qrConsoleTimer = null;
    }
}

function scheduleConsoleQr(qr) {
    const sequence = ++qrConsoleSequence;
    clearConsoleQrTimer();
    qrConsoleTimer = setTimeout(() => {
        if (sequence !== qrConsoleSequence || qrAtual !== qr) return;
        console.log('\n\n======================================');
        console.log('Escaneie o QRCode abaixo para conectar:');
        console.log('======================================\n');
        qrcode.generate(qr, { small: true });
    }, 180);
    qrConsoleTimer.unref?.();
}

function clearConnectionData() {
    clearConsoleQrTimer();
    ready = false;
    qrAtual = null;
    qrDataUrl = null;
    numeroConectado = null;
}

function timeoutPromise(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
    });
    return Promise.race([
        Promise.resolve(promise).catch(() => undefined),
        timeout,
    ]).finally(() => clearTimeout(timer));
}

async function destroyClientInstance(instance) {
    if (!instance || destroyingClients.has(instance)) return;
    destroyingClients.add(instance);
    try {
        instance.removeAllListeners?.();
        await timeoutPromise(instance.destroy?.(), DESTROY_TIMEOUT_MS);
    } catch {
        // O Chromium pode ja ter encerrado; a limpeza continua sendo considerada concluida.
    }
}

function scheduleDestroy(instance) {
    if (!instance || destroyingClients.has(instance)) return cleanupPromise;
    cleanupPromise = cleanupPromise
        .catch(() => undefined)
        .then(() => destroyClientInstance(instance));
    return cleanupPromise;
}

function createAttempt(id) {
    let resolveAttempt;
    let rejectAttempt;
    let settled = false;
    const promise = new Promise((resolve, reject) => {
        resolveAttempt = resolve;
        rejectAttempt = reject;
    });
    return {
        id,
        promise,
        timer: null,
        resolve(value) {
            if (settled) return;
            settled = true;
            clearTimeout(this.timer);
            resolveAttempt(value);
        },
        reject(error) {
            if (settled) return;
            settled = true;
            clearTimeout(this.timer);
            rejectAttempt(error);
        },
        isSettled: () => settled,
    };
}

function cancelActiveAttempt(error) {
    const attempt = activeAttempt;
    activeAttempt = null;
    if (attempt) attempt.reject(error || new Error('Inicializacao do WhatsApp cancelada.'));
}

function failCurrentClient(instance, error) {
    if (!instance || client !== instance) return;
    const failure = error instanceof Error ? error : new Error(errorMessage(error));
    lifecycleId += 1;
    cancelActiveAttempt(failure);
    client = null;
    startingPromise = null;
    clearConnectionData();
    connectionState = 'desconectado';
    ultimoErro = errorMessage(failure);
    emitStatus();
    scheduleDestroy(instance);
}

function attachClientEvents(instance, attempt) {
    instance.on('qr', async (qr) => {
        if (client !== instance) return;
        qrAtual = qr;
        qrDataUrl = null;
        ready = false;
        numeroConectado = null;
        connectionState = 'aguardando_qr';
        ultimoErro = null;
        attempt.resolve(instance);

        try {
            const generated = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
            if (client !== instance || qrAtual !== qr) return;
            qrDataUrl = generated;
            scheduleConsoleQr(qr);
            events.emit('qr', { qrDataUrl });
            emitStatus();
        } catch (error) {
            if (client !== instance) return;
            ultimoErro = errorMessage(error, 'Nao foi possivel renderizar o QR Code.');
            emitStatus();
        }
    });

    instance.on('ready', () => {
        if (client !== instance) return;
        ready = true;
        qrAtual = null;
        qrDataUrl = null;
        numeroConectado = instance.info?.wid?.user ? `+${instance.info.wid.user}` : null;
        connectionState = 'conectado';
        ultimoErro = null;
        attempt.resolve(instance);
        emitStatus();
        try {
            onReadyCallback?.();
        } catch (error) {
            console.error('Falha no callback de conexao do WhatsApp:', error);
        }
    });

    instance.on('auth_failure', (message) => {
        failCurrentClient(instance, new Error(message || 'Falha na autenticacao do WhatsApp.'));
    });

    instance.on('disconnected', (reason) => {
        failCurrentClient(instance, new Error(reason || 'WhatsApp desconectado.'));
    });
}

function iniciar() {
    if (shuttingDown) return Promise.reject(new Error('O aplicativo esta sendo encerrado.'));
    if (resetPromise) return resetPromise.then(() => iniciar());
    if (ready && client) return Promise.resolve(client);
    if (client && (connectionState === 'iniciando' || connectionState === 'aguardando_qr')) {
        return startingPromise || Promise.resolve(client);
    }
    if (startingPromise) return startingPromise;

    const attemptId = ++lifecycleId;
    const attempt = createAttempt(attemptId);
    activeAttempt = attempt;
    clearConnectionData();
    connectionState = 'iniciando';
    ultimoErro = null;
    emitStatus();

    const run = (async () => {
        await cleanupPromise.catch(() => undefined);
        if (attemptId !== lifecycleId || activeAttempt !== attempt) {
            throw new Error('Inicializacao do WhatsApp cancelada.');
        }

        let instance;
        try {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
            const executablePath = resolveBrowserExecutable();
            instance = new Client({
                authStrategy: new LocalAuth({ clientId: AUTH_ID, dataPath: AUTH_DIR }),
                puppeteer: { executablePath },
            });
            client = instance;
            attachClientEvents(instance, attempt);

            const timeoutMs = initializationTimeoutMs();
            attempt.timer = setTimeout(() => {
                failCurrentClient(
                    instance,
                    new Error(`Tempo limite de ${Math.round(timeoutMs / 1000)}s excedido ao iniciar o WhatsApp.`),
                );
            }, timeoutMs);
            attempt.timer.unref?.();

            Promise.resolve(instance.initialize()).catch((error) => {
                failCurrentClient(instance, error);
            });
        } catch (error) {
            if (instance && client === instance) failCurrentClient(instance, error);
            else {
                lifecycleId += 1;
                activeAttempt = null;
                clearConnectionData();
                connectionState = 'desconectado';
                ultimoErro = errorMessage(error);
                emitStatus();
                attempt.reject(error);
            }
        }

        return attempt.promise;
    })();

    startingPromise = run;
    run.then(
        () => {
            if (startingPromise === run) startingPromise = null;
            if (activeAttempt === attempt) activeAttempt = null;
        },
        () => {
            if (startingPromise === run) startingPromise = null;
            if (activeAttempt === attempt) activeAttempt = null;
        },
    );
    return run;
}

async function removeSessionDirectory() {
    const target = sessionDirectory();
    try {
        const stats = await fs.promises.lstat(target);
        if (stats.isSymbolicLink()) {
            await fs.promises.unlink(target);
            return;
        }
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 4 });
}

function resetar() {
    if (resetPromise) return resetPromise.then(() => statusPayload());

    lifecycleId += 1;
    cancelActiveAttempt(new Error('Conexao reiniciada pelo usuario.'));
    const instance = client;
    client = null;
    startingPromise = null;
    clearConnectionData();
    connectionState = 'desconectado';
    ultimoErro = null;
    emitStatus();

    const operation = (async () => {
        await scheduleDestroy(instance);
        await removeSessionDirectory();
    })();
    resetPromise = operation;

    return operation.then(
        () => {
            if (resetPromise === operation) resetPromise = null;
            if (!shuttingDown) iniciar().catch(() => undefined);
            return statusPayload();
        },
        (error) => {
            if (resetPromise === operation) resetPromise = null;
            connectionState = 'desconectado';
            ultimoErro = errorMessage(error, 'Nao foi possivel redefinir a conexao do WhatsApp.');
            emitStatus();
            throw error;
        },
    );
}

async function encerrar() {
    shuttingDown = true;
    lifecycleId += 1;
    cancelActiveAttempt(new Error('Aplicativo encerrado.'));
    const instance = client;
    client = null;
    startingPromise = null;
    clearConnectionData();
    connectionState = 'desconectado';
    await resetPromise?.catch(() => undefined);
    await scheduleDestroy(instance);
}

module.exports = {
    iniciar,
    resetar,
    encerrar,
    isReady: () => ready,
    getClient: () => client,
    getStatus: () => statusPayload(),
    onReady: (callback) => { onReadyCallback = callback; },
    on: (eventName, callback) => {
        events.on(eventName, callback);
        return () => events.off(eventName, callback);
    },
    _internals: {
        AUTH_DIR,
        SESSION_DIR_NAME,
        initializationTimeoutMs,
        resolveBrowserExecutable,
        sessionDirectory,
        systemBrowserCandidates,
    },
};
