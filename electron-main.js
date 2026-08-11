const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

app.setName('Vale Verde Dashboard');
const userDataPath = app.getPath('userData');
const localListsPath = path.join(process.cwd(), 'listas');
if (!process.env.VALEVERDE_LISTS_DIR && fs.existsSync(localListsPath)) process.env.VALEVERDE_LISTS_DIR = localListsPath;
process.env.VALEVERDE_DATA_DIR ||= path.join(userDataPath, 'data');
process.env.VALEVERDE_REPORTS_DIR ||= path.join(userDataPath, 'reports');
process.env.VALEVERDE_TEMPLATES_DIR ||= path.join(userDataPath, 'templates');
process.env.VALEVERDE_AUTH_DIR ||= path.join(userDataPath, 'whatsapp-auth');

const whatsapp = require('./core/whatsapp');
const database = require('./core/database');
const templates = require('./core/templates-store');
const importer = require('./core/importer');
const sender = require('./core/sender');
const report = require('./core/report');
const gemini = require('./core/gemini');
const { AiCredentialStore } = require('./core/ai-credentials');
const aiSpreadsheets = require('./core/ai-spreadsheets');
const listSync = require('./core/sync-lists');
const pixUtils = require('./core/pix');
const defaults = require('./config');

const aiCredentialStore = new AiCredentialStore({
    filePath: process.env.VALEVERDE_AI_CREDENTIALS_PATH
        || path.join(process.env.VALEVERDE_DATA_DIR, 'ai-credentials.json'),
    safeStorage,
});
gemini.configureProviderResolver(() => aiCredentialStore.getActiveCredential());

let mainWindow;
let activeCampaign = null;
const verifiedCampaignTests = new Map();
const TEST_VALIDITY_MS = 60 * 60 * 1000;

function messageFingerprint(message, pix = {}) {
    const payload = JSON.stringify({
        mensagem: String(message || ''),
        pix: pixUtils.normalizePixSettings(pix),
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function getVerifiedTest(testId, message, pix) {
    const test = verifiedCampaignTests.get(String(testId || ''));
    if (!test || test.expiresAt < Date.now() || test.messageHash !== messageFingerprint(message, pix)) {
        throw new Error('Envie um novo teste depois de qualquer alteracao na mensagem ou nos dados PIX.');
    }
    return test;
}

function secondsFromMilliseconds(value, fallback) {
    const seconds = Number(value) / 1000;
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : fallback;
}

function appSettings() {
    const saved = database.getConfig();
    const min = Number(saved.intervaloMin ?? secondsFromMilliseconds(defaults.tempoMin, 5));
    const max = Number(saved.intervaloMax ?? secondsFromMilliseconds(defaults.tempoMax, 11));
    const pixFields = pixUtils.pixSettingsWithLegacyAliases(saved, defaults.pix || defaults);
    return {
        ...pixFields,
        intervaloMin: Math.max(3, Math.min(min || 5, 60)),
        intervaloMax: Math.max(5, Math.min(Math.max(max || 11, min || 5), 120)),
    };
}

function aiPublicStatus() {
    const providerNames = { gemini: 'Google Gemini', openai: 'OpenAI' };
    let vault;
    let configurationError = '';
    try {
        vault = aiCredentialStore.getPublicStatus();
    } catch (error) {
        configurationError = String(error?.message || 'Nao foi possivel abrir o cofre seguro de IA.');
        vault = {
            activeProvider: 'gemini',
            providers: {
                gemini: { configured: false, model: 'gemini-3.6-flash', maskedKey: '' },
                openai: { configured: false, model: 'gpt-5.6-terra', maskedKey: '' },
            },
        };
    }

    const provider = ['gemini', 'openai'].includes(vault.activeProvider)
        ? vault.activeProvider
        : 'gemini';
    const publicProviders = Object.fromEntries(['gemini', 'openai'].map((name) => {
        const saved = vault.providers?.[name] || {};
        const maskedKey = String(saved.maskedKey || '');
        const credentialError = String(saved.error || saved.erro || '');
        return [name, {
            configurado: Boolean(saved.configured),
            configured: Boolean(saved.configured),
            modelo: String(saved.model || ''),
            model: String(saved.model || ''),
            chaveMascarada: maskedKey,
            maskedKey,
            sufixo: maskedKey.slice(-4),
            erro: credentialError,
            error: credentialError,
        }];
    }));
    const active = publicProviders[provider];

    return {
        ...gemini.getStatus(),
        disponivel: active.configurado && !configurationError && !active.erro,
        provider,
        provedor: provider,
        provedorNome: providerNames[provider],
        model: active.modelo,
        modelo: active.modelo,
        provedores: publicProviders,
        erroConfiguracao: configurationError || active.erro,
    };
}

async function serializeBootstrap() {
    const sincronizacao = await listSync.synchronizeLists();
    const aiPersistida = database.getAiState();
    const historicoGemini = gemini.getConversationHistory('dashboard', { limit: 80 }).map((message, index) => ({
        id: `gemini-${index}-${message.createdAt || Date.now()}`,
        papel: message.role === 'user' ? 'gestor' : 'gemini',
        texto: String(message.text || ''),
        criadoEm: message.createdAt || new Date().toISOString(),
        metadados: {},
    }));
    return {
        clientes: database.listCustomers(),
        produtos: database.listProducts(),
        relatorios: database.listReports(),
        importacoes: database.listImports(),
        sincronizacao,
        templates: templates.listTemplates(),
        configuracoes: appSettings(),
        whatsapp: whatsapp.getStatus(),
        gemini: {
            ...aiPersistida,
            ...aiPublicStatus(),
            conversa: historicoGemini.length ? historicoGemini : aiPersistida.conversa,
        },
    };
}

async function aiOptions(options = {}) {
    const whatsappStatus = whatsapp.getStatus();
    return {
        ...options,
        spreadsheets: await aiSpreadsheets.loadSpreadsheetSources(listSync.LISTS_DIR),
        runtime: {
            whatsapp: {
                status: whatsappStatus.status,
                numero: whatsappStatus.numero ? 'vinculado' : '',
                erro: Boolean(whatsappStatus.erro),
            },
            campaign: {
                active: Boolean(activeCampaign),
                paused: activeCampaign?.pausado === true,
                cancelRequested: activeCampaign?.cancelado === true,
            },
        },
    };
}

function emitToRenderer(channel, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
}

function validateCampaign(payload = {}) {
    const tipo = payload.tipo === 'cobranca' ? 'cobranca' : 'promocao';
    const mensagem = String(payload.mensagem || '').trim();
    const recipientIds = Array.isArray(payload.recipientIds) ? [...new Set(payload.recipientIds.map(String))] : [];
    if (!mensagem) throw new Error('A mensagem da campanha nao pode ficar vazia.');
    if (!recipientIds.length) throw new Error('Selecione pelo menos um destinatario.');
    const settings = appSettings();
    const pix = pixUtils.normalizePixSettings(settings.pix);
    const test = getVerifiedTest(payload.testeId, mensagem, pix);
    const intervaloMin = Number(payload.intervaloMin ?? settings.intervaloMin);
    const intervaloMax = Number(payload.intervaloMax ?? settings.intervaloMax);
    if (!Number.isFinite(intervaloMin) || !Number.isFinite(intervaloMax)
        || intervaloMin < 3 || intervaloMax > 120 || intervaloMin > intervaloMax) {
        throw new Error('Intervalo de envio invalido. Use valores entre 3 e 120 segundos.');
    }
    return {
        tipo,
        tipoEnvio: tipo === 'cobranca' ? 'devedores' : 'todos',
        somenteDevedores: tipo === 'cobranca',
        mensagem,
        pix,
        recipientIds,
        limiteMinimoDevedor: 50,
        tempoMin: Math.max(3000, Math.round(Math.min(intervaloMin, intervaloMax) * 1000)),
        tempoMax: Math.min(120000, Math.round(Math.max(intervaloMin, intervaloMax) * 1000)),
        testeValidadoEm: test.data,
    };
}

function registerIpcHandlers() {
    ipcMain.handle('app:bootstrap', () => serializeBootstrap());

    ipcMain.handle('lists:sync', () => listSync.synchronizeLists());

    ipcMain.handle('customers:import', async () => {
        const selection = await dialog.showOpenDialog(mainWindow, {
            title: 'Importar clientes',
            properties: ['openFile'],
            filters: [
                { name: 'Tabelas de clientes', extensions: ['xls', 'xlsx', 'csv', 'pdf'] },
                { name: 'Todos os arquivos', extensions: ['*'] },
            ],
        });
        if (selection.canceled || !selection.filePaths[0]) return { cancelado: true };

        const parsed = await importer.parseImportFile(selection.filePaths[0]);
        const result = database.importCustomers(parsed.rows, parsed.arquivo);
        return {
            cancelado: false,
            arquivo: parsed.arquivo,
            formato: parsed.formato,
            totalLido: parsed.totalLido,
            invalidos: parsed.invalidos,
            ...result,
        };
    });

    ipcMain.handle('customers:list', () => database.listCustomers());
    ipcMain.handle('reports:list', () => database.listReports());
    ipcMain.handle('reports:get', (_event, id) => database.getReport(id));
    ipcMain.handle('reports:show-in-folder', (_event, fileName) => {
        const report = database.getReport(String(fileName || ''));
        const file = report?.arquivos?.[0] || String(fileName || '');
        const reportPath = path.join(database.REPORTS_DIR, path.basename(file));
        if (!file || !fs.existsSync(reportPath)) throw new Error('Arquivo de relatorio indisponivel.');
        shell.showItemInFolder(reportPath);
        return true;
    });

    ipcMain.handle('settings:save', (_event, input = {}) => {
        const current = appSettings();
        const min = Number(input.intervaloMin ?? current.intervaloMin);
        const max = Number(input.intervaloMax ?? current.intervaloMax);
        if (!Number.isFinite(min) || !Number.isFinite(max) || min < 3 || max > 120 || min > max) {
            throw new Error('Defina um intervalo entre 3 e 120 segundos, com minimo menor ou igual ao maximo.');
        }
        const requestedPix = pixUtils.normalizePixSettings(input.pix || input, current.pix);
        const pixCheck = pixUtils.validatePixSettings(requestedPix);
        if (!pixCheck.valid) throw new Error(pixCheck.message);
        database.saveConfig({
            ...pixUtils.pixSettingsWithLegacyAliases(pixCheck.pix),
            intervaloMin: Math.round(min),
            intervaloMax: Math.round(max),
        });
        return appSettings();
    });

    ipcMain.handle('ai:status', () => aiPublicStatus());
    ipcMain.handle('ai:settings-save', async (_event, input = {}) => {
        const candidate = aiCredentialStore.resolveCandidate(input);
        const validation = await gemini.validateProviderCredential(candidate);
        aiCredentialStore.save({
            provider: candidate.provider,
            model: validation.model || candidate.model,
            apiKey: candidate.apiKey,
        });
        gemini.invalidateCaches();
        return aiPublicStatus();
    });
    ipcMain.handle('ai:credential-remove', (_event, provider) => {
        aiCredentialStore.remove(provider);
        gemini.invalidateCaches();
        return aiPublicStatus();
    });

    ipcMain.handle('templates:list', () => templates.listTemplates());
    ipcMain.handle('templates:save', (_event, template) => templates.saveTemplate(template || {}));
    ipcMain.handle('templates:delete', (_event, id) => templates.deleteTemplate(String(id || '')));
    ipcMain.handle('templates:import', async () => {
        const selection = await dialog.showOpenDialog(mainWindow, {
            title: 'Importar template de mensagem',
            properties: ['openFile'],
            filters: [{ name: 'Arquivo de texto', extensions: ['txt'] }],
        });
        if (selection.canceled || !selection.filePaths[0]) return { cancelado: true };
        const filePath = selection.filePaths[0];
        const texto = fs.readFileSync(filePath, 'utf8').trim();
        const nome = path.basename(filePath, path.extname(filePath));
        return { cancelado: false, template: templates.saveTemplate({ nome, texto }) };
    });

    ipcMain.handle('whatsapp:start', async () => {
        // O modulo persiste e publica a falha; apenas evitamos uma rejeicao sem consumidor no IPC.
        whatsapp.iniciar().catch(() => undefined);
        return whatsapp.getStatus();
    });
    ipcMain.handle('whatsapp:status', () => whatsapp.getStatus());
    ipcMain.handle('whatsapp:reset', () => whatsapp.resetar());

    ipcMain.handle('campaign:test', async (_event, input = {}) => {
        if (!whatsapp.isReady()) throw new Error('Conecte o WhatsApp antes de enviar o teste.');
        const customerExample = database.listCustomers()[0];
        if (!customerExample) throw new Error('Importe pelo menos um cliente real antes de enviar o teste.');
        const settings = appSettings();
        const pix = pixUtils.normalizePixSettings(settings.pix);
        const resultado = await sender.enviarTeste({
            telefone: String(input.telefone || ''),
            mensagem: String(input.mensagem || ''),
            clienteExemplo: customerExample,
            pix,
        }, whatsapp.getClient());
        const testeId = crypto.randomUUID();
        verifiedCampaignTests.set(testeId, {
            data: new Date().toISOString(),
            expiresAt: Date.now() + TEST_VALIDITY_MS,
            messageHash: messageFingerprint(input.mensagem, pix),
        });
        return { ...resultado, testeId };
    });

    ipcMain.handle('campaign:start', async (_event, payload = {}) => {
        if (activeCampaign) throw new Error('Ja existe uma campanha em andamento.');
        if (!whatsapp.isReady()) throw new Error('Conecte o WhatsApp antes de iniciar a campanha.');

        const campaign = validateCampaign(payload);
        verifiedCampaignTests.delete(String(payload.testeId || ''));
        const selectedIds = new Set(campaign.recipientIds);
        const customers = database.listCustomers().filter((customer) => selectedIds.has(String(customer.id)));
        if (!customers.length) throw new Error('Os destinatarios selecionados nao estao mais disponiveis na base.');

        activeCampaign = { pausado: false, cancelado: false };
        try {
            const results = await sender.enviarMensagens(customers, whatsapp.getClient(), campaign, {
                tempoMin: campaign.tempoMin,
                tempoMax: campaign.tempoMax,
                shouldPause: () => activeCampaign?.pausado === true,
                shouldCancel: () => activeCampaign?.cancelado === true,
                onProgress: (progress) => emitToRenderer('campaign:progress', progress),
            });
            const files = await Promise.all([report.gerar(results), report.gerarCSV(results), report.gerarTXT(results)]);
            const savedReport = database.saveReportMetadata({ campanha: campaign, resultados: results, arquivos: files });
            const outcome = { relatorio: savedReport, cancelado: activeCampaign.cancelado, processados: results.length };
            emitToRenderer('campaign:finished', outcome);
            return outcome;
        } finally {
            activeCampaign = null;
        }
    });

    ipcMain.handle('campaign:pause', (_event, paused) => {
        if (!activeCampaign) throw new Error('Nenhuma campanha esta em andamento.');
        activeCampaign.pausado = Boolean(paused);
        return { pausado: activeCampaign.pausado };
    });
    ipcMain.handle('campaign:cancel', () => {
        if (!activeCampaign) throw new Error('Nenhuma campanha esta em andamento.');
        activeCampaign.cancelado = true;
        activeCampaign.pausado = false;
        return true;
    });

    ipcMain.handle('gemini:status', () => aiPublicStatus());
    ipcMain.handle('gemini:executive-report', async () => {
        const response = await gemini.generateExecutiveReportDetailed(
            database.listCustomers(),
            database.listProducts(),
            database.listImports(),
            database.listReports(),
            await aiOptions(),
        );
        database.saveAiState({ relatorio: response.texto || response.text });
        return response;
    });
    ipcMain.handle('gemini:ask', async (_event, input = {}) => gemini.answerQuestionDetailed(
        database.listCustomers(),
        database.listProducts(),
        database.listImports(),
        database.listReports(),
        String(input.pergunta || ''),
        String(input.relatorioAnterior || ''),
        await aiOptions({ sessionId: 'dashboard' }),
    ));
    ipcMain.handle('gemini:diagnose', async () => {
        const response = await gemini.diagnoseOperationsDetailed(
            database.listCustomers(),
            database.listProducts(),
            database.listImports(),
            database.listReports(),
            await aiOptions(),
        );
        database.saveAiState({ diagnostico: response.texto || response.text });
        return response;
    });
    ipcMain.handle('gemini:suggest-campaign', async (_event, input = {}) => gemini.suggestCampaignMessageDetailed(
        database.listCustomers(),
        database.listProducts(),
        input,
        await aiOptions(),
    ));
    ipcMain.handle('gemini:clear-history', () => {
        gemini.clearConversationHistory('dashboard');
        database.clearAiConversation();
        return true;
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1380,
        height: 900,
        minWidth: 390,
        minHeight: 520,
        show: false,
        backgroundColor: '#eef3ef',
        icon: path.join(__dirname, 'logo.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    const abrirUrlExterna = (url) => {
        try {
            const parsed = new URL(url);
            if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) return;
            shell.openExternal(parsed.toString()).catch(() => {});
        } catch {
            // Links invalidos ou protocolos internos sao ignorados.
        }
    };
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        abrirUrlExterna(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        const destino = String(url || '').split('#')[0];
        const atual = String(mainWindow.webContents.getURL() || '').split('#')[0];
        if (!atual || destino === atual) return;
        event.preventDefault();
        abrirUrlExterna(url);
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadFile(path.join(__dirname, 'dashboard', 'index.html'));
}

app.whenReady().then(() => {
    registerIpcHandlers();
    whatsapp.on('status', (status) => emitToRenderer('whatsapp:status', status));
    createWindow();
});

let encerramentoEmAndamento = false;
app.on('before-quit', (event) => {
    if (encerramentoEmAndamento) return;
    event.preventDefault();
    encerramentoEmAndamento = true;
    whatsapp.encerrar()
        .catch((error) => console.error('Falha ao encerrar o WhatsApp:', error))
        .finally(() => app.quit());
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
