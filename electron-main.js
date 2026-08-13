const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

app.setName('Vale Verde Dashboard');
const userDataPath = app.getPath('userData');
process.env.VALEVERDE_DATA_DIR ||= path.join(userDataPath, 'data');
process.env.VALEVERDE_REPORTS_DIR ||= path.join(userDataPath, 'reports');
process.env.VALEVERDE_TEMPLATES_DIR ||= path.join(userDataPath, 'templates');
process.env.VALEVERDE_AUTH_DIR ||= path.join(userDataPath, 'whatsapp-auth');

const whatsapp = require('./core/whatsapp');
const database = require('./core/database');
const templates = require('./core/templates-store');
const sender = require('./core/sender');
const report = require('./core/report');
const gemini = require('./core/gemini');
const { AiCredentialStore } = require('./core/ai-credentials');
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
let consumerBackupImportActive = false;
let consumerDataCache = null;
let consumerBackupSyncService = null;
const verifiedCampaignTests = new Map();
const TEST_VALIDITY_MS = 60 * 60 * 1000;

function consumerDatabasePath() {
    return path.join(process.env.VALEVERDE_DATA_DIR, 'consumer-analytics.sqlite');
}

function readConsumerData() {
    const databasePath = consumerDatabasePath();
    if (!fs.existsSync(databasePath)) {
        return { imports: [], profiles: [], summary: null, error: '' };
    }

    const stats = fs.statSync(databasePath);
    const signature = `${stats.size}:${stats.mtimeMs}`;
    if (consumerDataCache?.signature === signature) return consumerDataCache.value;

    let store;
    try {
        const { createConsumerStore } = require('./core/consumer-store');
        store = createConsumerStore({ databasePath }).initialize();
        const imports = store.listImports({ limit: 100 });
        if (imports[0]) store.reconcileCompletedImportAsAuthoritative(imports[0].id);
        const profiles = [];
        const pageSize = 1000;
        for (let offset = 0; ; offset += pageSize) {
            const page = store.listCustomerProfiles({ limit: pageSize, offset });
            profiles.push(...page);
            if (page.length < pageSize) break;
        }
        const value = {
            imports,
            profiles,
            summary: imports.length ? store.getBusinessSummary() : null,
            error: '',
        };
        consumerDataCache = { signature, value };
        return value;
    } catch (error) {
        console.error('Falha ao ler a base analitica do Consumer:', error);
        return { imports: [], profiles: [], summary: null, error: String(error?.message || error) };
    } finally {
        store?.close();
    }
}

function readConsumerHistoryProfiles() {
    const consumer = readConsumerData();
    if (!consumer.imports.length) return [];
    if (Array.isArray(consumer.historyProfiles)) return consumer.historyProfiles;

    let store;
    try {
        const { createConsumerStore } = require('./core/consumer-store');
        store = createConsumerStore({ databasePath: consumerDatabasePath() }).initialize();
        const profiles = [];
        const pageSize = 500;
        for (let offset = 0; ; offset += pageSize) {
            const page = store.listCustomerProfiles({ limit: pageSize, offset, includeHistory: true });
            profiles.push(...page);
            if (page.length < pageSize) break;
        }
        consumer.historyProfiles = profiles;
        return profiles;
    } catch (error) {
        console.error('Falha ao ler os historicos detalhados do Consumer:', error);
        return [];
    } finally {
        store?.close();
    }
}

function getConsumerCustomerProfile(sourceKey, externalId) {
    const safeSourceKey = String(sourceKey || '').trim().slice(0, 200);
    const safeExternalId = String(externalId || '').trim().slice(0, 200);
    if (!safeSourceKey || !safeExternalId || !fs.existsSync(consumerDatabasePath())) return null;

    let store;
    try {
        const { createConsumerStore } = require('./core/consumer-store');
        store = createConsumerStore({ databasePath: consumerDatabasePath() }).initialize();
        const profile = store.getCustomerProfile({
            sourceKey: safeSourceKey,
            externalId: safeExternalId,
            includeHistory: true,
        });
        if (!profile) return null;
        const { publicConsumerProfile } = require('./core/consumer-profiles');
        return publicConsumerProfile(profile);
    } finally {
        store?.close();
    }
}

function operationalCustomerData() {
    const existing = database.listCustomers();
    const consumer = readConsumerData();
    if (!consumer.profiles.length) {
        return {
            customers: existing,
            consumer,
            links: { existing: existing.length, profiles: 0, matched: 0, created: 0, pending: 0 },
        };
    }
    const { combineConsumerCustomers } = require('./core/consumer-profiles');
    const combined = combineConsumerCustomers(existing, consumer.profiles);
    return { customers: combined.customers, consumer, links: combined.stats };
}

function listOperationalCustomers() {
    return operationalCustomerData().customers;
}

function loadConsumerBackupImporter() {
    // O Firebird e o SQLite so sao carregados quando o usuario inicia uma importacao.
    // Assim, uma dependencia ausente ou uma instalacao antiga nao impede o app de abrir.
    const consumerBackup = require('./core/consumer-backup');
    if (typeof consumerBackup?.importConsumerBackup !== 'function') {
        throw new Error('O importador de backup do Consumer nao esta disponivel nesta instalacao.');
    }
    return consumerBackup.importConsumerBackup;
}

function emitConsumerBackupProgress(event, progress) {
    const sender = event?.sender;
    if (!sender || sender.isDestroyed()) return;
    const payload = progress && typeof progress === 'object'
        ? { ...progress }
        : { mensagem: String(progress || 'Processando o backup do Consumer...') };
    sender.send('consumer-backup:progress', payload);
}

function backupFileName(result = {}, fallback = '') {
    const candidate = result.arquivo || result.nomeArquivo || result.fileName || fallback;
    return path.basename(String(candidate || 'backup-consumer.fbconsumer'));
}

function backupSignature(result = {}) {
    return String(
        result.assinatura
        || result.sha256
        || result.hash
        || result.source?.sha256
        || '',
    );
}

function backupRowsRead(result = {}) {
    if (Number.isFinite(Number(result.totalLido))) return Number(result.totalLido);
    const summary = result.resumo && typeof result.resumo === 'object' ? result.resumo : {};
    return ['clientes', 'pedidos', 'itens', 'pagamentos', 'produtos', 'entregas', 'contaCorrente']
        .reduce((total, field) => total + (Number.isFinite(Number(summary[field])) ? Number(summary[field]) : 0), 0);
}

function saveConsumerBackupMetadata(result = {}, fallbackFileName = '') {
    const { dataFileFormat } = require('./core/data-import');
    const signature = backupSignature(result);
    const importId = String(result.importacaoId || result.importId || result.id || signature || Date.now());
    const resultStatus = String(result.status || '').toLowerCase();
    const unchanged = ['duplicada', 'duplicate', 'anterior', 'older', 'atualizada', 'up_to_date'].includes(resultStatus);
    const rowsRead = backupRowsRead(result);
    return database.saveImportMetadata({
        id: `consumer:${importId}`,
        arquivo: backupFileName(result, fallbackFileName),
        tipo: 'consumer-backup',
        formato: dataFileFormat(backupFileName(result, fallbackFileName), 'FIREBIRD'),
        assinatura: signature,
        status: 'concluida',
        totalLido: rowsRead,
        created: unchanged ? 0 : rowsRead,
        updated: 0,
        ignored: unchanged ? rowsRead : 0,
        erro: '',
    });
}

function saveConsumerBackupError(error, fallbackFileName = '') {
    try {
        const { dataFileFormat } = require('./core/data-import');
        database.saveImportMetadata({
            id: `consumer:erro:${Date.now()}`,
            arquivo: path.basename(String(fallbackFileName || 'backup-consumer.fbconsumer')),
            tipo: 'consumer-backup',
            formato: dataFileFormat(fallbackFileName, 'FIREBIRD'),
            status: 'erro',
            erro: String(error?.message || error || 'Falha ao importar o backup.').slice(0, 1000),
        });
    } catch {
        // A falha de auditoria nao deve esconder o erro original da importacao.
    }
}

async function runConsumerBackupImport(event, options, fallbackFileName) {
    if (consumerBackupImportActive) {
        throw new Error('Ja existe uma importacao de backup do Consumer em andamento.');
    }

    consumerBackupImportActive = true;
    try {
        const importConsumerBackup = loadConsumerBackupImporter();
        const result = await importConsumerBackup({
            ...options,
            onProgress: (progress) => emitConsumerBackupProgress(event, progress),
        });
        consumerDataCache = null;
        const normalizedStatus = normalizeConsumerImportStatus(result);
        const normalized = {
            cancelado: false,
            ...(result && typeof result === 'object' ? result : {}),
            status: normalizedStatus,
            arquivo: backupFileName(result, fallbackFileName),
        };
        const operational = operationalCustomerData();
        normalized.vinculacao = operational.links;
        if (operational.links.pending > 0) {
            normalized.avisos = [
                ...(Array.isArray(normalized.avisos) ? normalized.avisos : []),
                `${operational.links.pending} perfil(is) possuem CPF/CNPJ ou telefone compartilhado e ficaram pendentes para evitar unir pessoas diferentes.`,
            ];
        }
        saveConsumerBackupMetadata(normalized, fallbackFileName);
        return normalized;
    } catch (error) {
        saveConsumerBackupError(error, fallbackFileName);
        throw error;
    } finally {
        consumerBackupImportActive = false;
    }
}

function normalizeConsumerImportStatus(result = {}) {
    const status = String(result.status || '').toLowerCase();
    if (['duplicate', 'duplicated', 'duplicada'].includes(status)) return 'duplicada';
    if (status === 'older') return 'anterior';
    if (status === 'up_to_date') return 'atualizada';
    return String(result.status || 'concluida');
}

function getConsumerBackupSyncService() {
    if (consumerBackupSyncService) return consumerBackupSyncService;
    const { createConsumerBackupSyncService } = require('./core/consumer-sync');
    consumerBackupSyncService = createConsumerBackupSyncService({
        importBackup: async (options) => {
            if (consumerBackupImportActive) {
                const error = new Error('Ja existe uma importacao de backup do Consumer em andamento.');
                error.code = 'CONSUMER_IMPORT_BUSY';
                throw error;
            }
            consumerBackupImportActive = true;
            try {
                const result = await loadConsumerBackupImporter()(options);
                consumerDataCache = null;
                const normalized = {
                    cancelado: false,
                    ...result,
                    status: normalizeConsumerImportStatus(result),
                    arquivo: backupFileName(result, options.sourceName),
                };
                const operational = operationalCustomerData();
                normalized.vinculacao = operational.links;
                saveConsumerBackupMetadata(normalized, options.sourceName);
                return { ...result, vinculacao: operational.links };
            } catch (error) {
                saveConsumerBackupError(error, options.sourceName);
                throw error;
            } finally {
                consumerBackupImportActive = false;
            }
        },
        getConfig: () => database.getConfig(),
        saveConfig: (patch) => database.saveConfig(patch),
    });
    consumerBackupSyncService.onStatus((status) => emitToRenderer('consumer-backup:sync-status', status));
    return consumerBackupSyncService;
}

async function syncConsumerBackupFolder(event, input = {}) {
    const url = String(input?.url || '').trim();
    const sync = getConsumerBackupSyncService();
    const result = await sync.sync({
        url: url || undefined,
        save: input?.save === true,
        reason: input?.reason || 'manual',
        onProgress: (progress) => emitConsumerBackupProgress(event, progress),
    });
    consumerDataCache = null;
    const status = normalizeConsumerImportStatus(result);
    const normalized = {
        cancelado: false,
        ...result,
        status,
        arquivo: backupFileName(result, result.fileName),
        pastaSalva: input?.save === true || getConsumerBackupSyncService().getStatus().enabled,
        sincronizadoEm: getConsumerBackupSyncService().getStatus().lastSyncedAt,
    };
    if (!normalized.resumo && result.importResult?.resumo) normalized.resumo = result.importResult.resumo;
    if (!normalized.avisos && result.importResult?.avisos) normalized.avisos = result.importResult.avisos;
    return normalized;
}

function startConsumerBackupSync(options = {}) {
    const service = getConsumerBackupSyncService();
    const started = service.start({
        immediate: options.immediate !== false,
        onProgress: (progress) => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            emitConsumerBackupProgress({ sender: mainWindow.webContents }, progress);
        },
        onResult: (result) => {
            consumerDataCache = null;
            emitToRenderer('consumer-backup:sync-status', service.getStatus());
            if (String(result?.status || '').toLowerCase() === 'success') {
                emitToRenderer('consumer-backup:data-updated', {
                    updatedAt: new Date().toISOString(),
                    importacaoId: String(result.importacaoId || result.importId || ''),
                });
            }
        },
        onError: (error) => {
            console.error('Falha na sincronizacao automatica do backup Consumer:', error?.message || error);
            emitToRenderer('consumer-backup:sync-status', service.getStatus());
        },
    });
    return started;
}

async function runDataFileImport(event, filePath, options = {}) {
    const {
        classifyDataFile,
        importDocumentDataFile,
    } = require('./core/data-import');
    const classification = classifyDataFile(filePath);
    const sourceKind = String(options.sourceKind || 'local');
    if (classification.kind === 'consumer-backup') {
        const result = await runConsumerBackupImport(event, {
            filePath,
            sourceKind,
            sourceName: options.sourceName || path.basename(filePath),
            driveFileId: options.driveFileId,
            backupCreatedAt: options.backupCreatedAt,
            modifiedAt: options.modifiedAt,
        }, options.sourceName || path.basename(filePath));
        return {
            ...result,
            tipoImportacao: 'consumer-backup',
            tipoFonte: sourceKind,
        };
    }

    const result = await importDocumentDataFile(filePath, {
        sourceKind,
        sourceName: options.sourceName || path.basename(filePath),
    });
    return {
        ...result,
        tipoFonte: sourceKind,
    };
}

async function runDataUrlImport(event, input = {}) {
    const url = String(input?.url || '').trim();
    if (!url) throw new Error('Informe o link compartilhado do Google Drive.');

    const { parseGoogleDriveSourceUrl } = require('./core/google-drive-folder');
    const parsed = parseGoogleDriveSourceUrl(url);
    if (parsed.sourceType === 'folder') {
        const result = await syncConsumerBackupFolder(event, {
            url,
            save: true,
            reason: 'manual',
        });
        startConsumerBackupSync({ immediate: false });
        return {
            ...result,
            tipoImportacao: 'consumer-backup',
            tipoFonte: 'drive-folder',
        };
    }

    const {
        downloadGoogleDriveDataFile,
        removeDownloadedDataFile,
    } = require('./core/data-import');
    let downloaded;
    try {
        emitConsumerBackupProgress(event, {
            stage: 'download',
            etapa: 'download',
            message: 'Baixando o arquivo do Google Drive…',
            mensagem: 'Baixando o arquivo do Google Drive…',
            percent: 1,
            percentual: 1,
        });
        downloaded = await downloadGoogleDriveDataFile(url, {
            onProgress: ({ received, total }) => {
                const percent = total ? Math.min(18, Math.max(1, Math.round((received / total) * 18))) : null;
                emitConsumerBackupProgress(event, {
                    stage: 'download',
                    etapa: 'download',
                    message: 'Baixando o arquivo do Google Drive…',
                    mensagem: 'Baixando o arquivo do Google Drive…',
                    receivedBytes: received,
                    totalBytes: total,
                    percent,
                    percentual: percent,
                });
            },
        });
        return await runDataFileImport(event, downloaded.filePath, {
            sourceKind: 'drive-file',
            sourceName: downloaded.fileName,
            driveFileId: downloaded.fileId,
            modifiedAt: downloaded.modifiedAt,
        });
    } finally {
        if (downloaded) {
            try {
                await removeDownloadedDataFile(downloaded);
            } catch (error) {
                console.error('Falha ao remover arquivo temporario do Google Drive:', error?.message || error);
            }
        }
    }
}

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
        ...saved,
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
    const sincronizacao = {
        automatico: false,
        processados: 0,
        ignorados: 0,
        erros: 0,
        detalhes: [],
    };
    const operational = operationalCustomerData();
    const aiPersistida = database.getAiState();
    const historicoGemini = gemini.getConversationHistory('dashboard', { limit: 80 }).map((message, index) => ({
        id: `gemini-${index}-${message.createdAt || Date.now()}`,
        papel: message.role === 'user' ? 'gestor' : 'gemini',
        texto: String(message.text || ''),
        criadoEm: message.createdAt || new Date().toISOString(),
        metadados: {},
    }));
    return {
        clientes: operational.customers,
        produtos: database.listProducts(),
        relatorios: database.listReports(),
        importacoes: database.listImports(),
        sincronizacao,
        consumer: {
            resumo: operational.consumer.summary,
            importacoes: operational.consumer.imports,
            vinculacao: operational.links,
            erro: operational.consumer.error,
            sincronizacao: getConsumerBackupSyncService().getStatus(),
        },
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
    const consumer = readConsumerData();
    return {
        ...options,
        budgetChars: options.budgetChars ?? 90000,
        spreadsheets: [],
        consumerAnalytics: consumer.summary || {},
        consumerProfiles: readConsumerHistoryProfiles(),
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

    ipcMain.handle('data-import:select-file', async (event) => {
        const selection = await dialog.showOpenDialog(mainWindow, {
            title: 'Importar fonte de dados',
            properties: ['openFile'],
            filters: [
                {
                    name: 'Fontes de dados compatíveis',
                    extensions: ['fb', 'fbconsumer', 'fbk', 'gbk', 'bak', 'backup', 'pdf', 'xls', 'xlsx', 'csv'],
                },
                { name: 'Backups Firebird / Consumer', extensions: ['fb', 'fbconsumer', 'fbk', 'gbk', 'bak', 'backup'] },
                { name: 'Documentos e planilhas', extensions: ['pdf', 'xls', 'xlsx', 'csv'] },
            ],
        });
        if (selection.canceled || !selection.filePaths[0]) return { cancelado: true };
        return runDataFileImport(event, selection.filePaths[0], { sourceKind: 'local' });
    });

    ipcMain.handle('data-import:from-url', (event, input = {}) => runDataUrlImport(event, input));

    ipcMain.handle('consumer-backup:sync-status', () => getConsumerBackupSyncService().getStatus());
    ipcMain.handle('consumer-backup:remove-folder', async () => {
        const service = getConsumerBackupSyncService();
        await service.disable();
        return {
            removida: true,
            sincronizacao: service.getStatus(),
        };
    });

    ipcMain.handle('customers:list', () => listOperationalCustomers());
    ipcMain.handle('consumer-profile:get', (_event, input = {}) => getConsumerCustomerProfile(
        input?.sourceKey,
        input?.externalId,
    ));
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
        const operationalCustomers = listOperationalCustomers();
        const requestedExampleId = String(input.clienteExemploId || '');
        const customerExample = requestedExampleId
            ? operationalCustomers.find((customer) => String(customer.id) === requestedExampleId)
            : operationalCustomers[0];
        if (!customerExample) {
            throw new Error(requestedExampleId
                ? 'O cliente usado na previa nao esta mais disponivel. Volte e revise os destinatarios.'
                : 'Importe pelo menos um cliente real antes de enviar o teste.');
        }
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
        const customers = listOperationalCustomers().filter((customer) => selectedIds.has(String(customer.id)));
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
            listOperationalCustomers(),
            database.listProducts(),
            database.listImports(),
            database.listReports(),
            await aiOptions(),
        );
        database.saveAiState({ relatorio: response.texto || response.text });
        return response;
    });
    ipcMain.handle('gemini:ask', async (_event, input = {}) => gemini.answerQuestionDetailed(
        listOperationalCustomers(),
        database.listProducts(),
        database.listImports(),
        database.listReports(),
        String(input.pergunta || ''),
        String(input.relatorioAnterior || ''),
        await aiOptions({ sessionId: 'dashboard' }),
    ));
    ipcMain.handle('gemini:diagnose', async () => {
        const response = await gemini.diagnoseOperationsDetailed(
            listOperationalCustomers(),
            database.listProducts(),
            database.listImports(),
            database.listReports(),
            await aiOptions(),
        );
        database.saveAiState({ diagnostico: response.texto || response.text });
        return response;
    });
    ipcMain.handle('gemini:suggest-campaign', async (_event, input = {}) => gemini.suggestCampaignMessageDetailed(
        listOperationalCustomers(),
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
    mainWindow.webContents.once('did-finish-load', () => startConsumerBackupSync());
});

let encerramentoEmAndamento = false;
app.on('before-quit', (event) => {
    if (encerramentoEmAndamento) return;
    event.preventDefault();
    encerramentoEmAndamento = true;
    consumerBackupSyncService?.stop();
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
