'use strict';

const path = require('node:path');

const {
    extractGoogleDriveFolderId,
    parseGoogleDriveSourceUrl,
    resolveGoogleDriveBackupSource,
} = require('./google-drive-folder');

const DEFAULT_SYNC_INTERVAL_MINUTES = 30;
const MIN_SYNC_INTERVAL_MINUTES = 1;
const MAX_SYNC_INTERVAL_MINUTES = 24 * 60;
const TERMINAL_STATUSES = new Set(['success', 'duplicate', 'older', 'up_to_date']);
const KNOWN_STATUSES = new Set(['never', 'success', 'duplicate', 'older', 'up_to_date', 'error']);

class ConsumerBackupSyncError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'ConsumerBackupSyncError';
        this.code = code;
    }
}

function canonicalizeGoogleDriveFolderUrl(input) {
    const folderId = extractGoogleDriveFolderId(input);
    return {
        folderId,
        folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
    };
}

function safeText(value, maximumLength = 500) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximumLength);
}

function safeIdentifier(value) {
    const text = safeText(value, 200);
    return /^[A-Za-z0-9_-]{10,200}$/.test(text) ? text : null;
}

function safeFileName(value) {
    const text = safeText(value, 260).replace(/<[^>]*>/g, '').replace(/\//g, '\\');
    const name = path.win32.basename(text).slice(0, 240);
    return name && name !== '.' && name !== '..' ? name : null;
}

function safeIsoDate(value) {
    if (!value) return null;
    const milliseconds = Date.parse(String(value));
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeSourceDate(value) {
    const text = safeText(value, 64);
    return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function safeHash(value) {
    const text = safeText(value, 64).toLowerCase();
    return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function safeErrorMessage(error) {
    const fallback = 'Nao foi possivel sincronizar o backup do Consumer.';
    const source = safeText(error?.message || error || fallback, 2000)
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[link omitido]')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\b(token|access_token|auth|resourcekey|key)=[^\s&]+/gi, '$1=[omitido]')
        .replace(/\s+/g, ' ')
        .trim();
    return (source || fallback).slice(0, 500);
}

function normalizeIntervalMinutes(value) {
    const interval = Number(value);
    if (!Number.isFinite(interval)) return DEFAULT_SYNC_INTERVAL_MINUTES;
    const rounded = Math.round(interval);
    if (rounded < MIN_SYNC_INTERVAL_MINUTES || rounded > MAX_SYNC_INTERVAL_MINUTES) {
        return DEFAULT_SYNC_INTERVAL_MINUTES;
    }
    return rounded;
}

function normalizeConsumerBackupSyncConfig(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    let canonical = null;
    try {
        if (source.folderUrl) canonical = canonicalizeGoogleDriveFolderUrl(source.folderUrl);
    } catch {
        // Configuracoes antigas ou adulteradas nao devem propagar links/tokens.
    }

    const lastStatus = safeText(source.lastStatus, 32);
    return {
        enabled: Boolean(source.enabled && canonical),
        folderUrl: canonical?.folderUrl || null,
        folderId: canonical?.folderId || null,
        intervalMinutes: normalizeIntervalMinutes(source.intervalMinutes),
        lastCheckedAt: safeIsoDate(source.lastCheckedAt),
        lastSyncedAt: safeIsoDate(source.lastSyncedAt),
        lastFileId: safeIdentifier(source.lastFileId),
        lastFileName: safeFileName(source.lastFileName),
        lastModifiedAt: safeIsoDate(source.lastModifiedAt),
        lastStatus: KNOWN_STATUSES.has(lastStatus) ? lastStatus : 'never',
        lastImportId: safeText(source.lastImportId, 200) || null,
        lastSha256: safeHash(source.lastSha256),
        lastError: source.lastError ? safeErrorMessage(source.lastError) : null,
    };
}

function normalizeNow(now) {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new ConsumerBackupSyncError('SYNC_CLOCK_INVALID', 'O relogio usado na sincronizacao retornou uma data invalida.');
    }
    return date.toISOString();
}

function normalizeImportStatus(result) {
    const status = safeText(result?.status, 32).toLowerCase();
    if (['completed', 'complete', 'imported', 'success'].includes(status)) return 'success';
    if (status === 'duplicate') return 'duplicate';
    if (status === 'older') return 'older';
    throw new ConsumerBackupSyncError(
        'SYNC_IMPORT_RESULT_INVALID',
        'A importacao terminou sem informar um resultado valido.',
    );
}

function createConsumerBackupSyncService(options = {}) {
    const resolveSource = options.resolveSource || resolveGoogleDriveBackupSource;
    const importBackup = options.importBackup;
    const getConfig = options.getConfig;
    const saveConfig = options.saveConfig;
    const now = options.now || (() => new Date());
    const intervalOverride = options.intervalMs === undefined ? null : Number(options.intervalMs);

    for (const [name, dependency] of Object.entries({ resolveSource, importBackup, getConfig, saveConfig, now })) {
        if (typeof dependency !== 'function') {
            throw new TypeError(`createConsumerBackupSyncService: ${name} deve ser uma funcao.`);
        }
    }
    if (intervalOverride !== null && (!Number.isFinite(intervalOverride) || intervalOverride <= 0)) {
        throw new TypeError('createConsumerBackupSyncService: intervalMs deve ser positivo.');
    }

    let running = false;
    let timer = null;

    function readStoredStatus() {
        const root = getConfig() || {};
        if (root && typeof root.then === 'function') {
            throw new TypeError('createConsumerBackupSyncService: getConfig deve ser sincrono.');
        }
        return normalizeConsumerBackupSyncConfig(root.consumerBackupSync);
    }

    let status = readStoredStatus();
    const stateListeners = new Set();

    function publishStatus() {
        const snapshot = getStatus();
        for (const listener of stateListeners) {
            try { listener(snapshot); } catch { /* observador externo */ }
        }
    }

    async function persist(next) {
        const candidate = normalizeConsumerBackupSyncConfig(next);
        await saveConfig({ consumerBackupSync: candidate });
        status = candidate;
        publishStatus();
        return status;
    }

    function emitProgress(listener, stage, message, percent = null) {
        if (typeof listener !== 'function') return;
        try {
            listener({
                stage,
                etapa: stage,
                message,
                mensagem: message,
                percent,
                percentual: percent,
            });
        } catch {
            // A interface nao pode interromper a sincronizacao.
        }
    }

    async function sync(syncOptions = {}) {
        const reason = safeText(syncOptions.reason, 32).toLowerCase() || 'manual';
        const automatic = ['automatic', 'auto', 'scheduled', 'startup'].includes(reason);
        if (running) {
            if (automatic) {
                return {
                    status: 'skipped',
                    reason: 'busy',
                    message: 'Uma sincronizacao do backup ja esta em andamento.',
                };
            }
            throw new ConsumerBackupSyncError(
                'SYNC_ALREADY_RUNNING',
                'Uma sincronizacao do backup ja esta em andamento. Aguarde a conclusao.',
            );
        }

        running = true;
        let storedStatus = null;
        let configuredFolder = false;
        let persistOnSuccess = false;
        let checkedAt = null;
        let canonical = null;
        let selected = null;

        try {
            storedStatus = readStoredStatus();
            status = storedStatus;
            const requestedUrl = safeText(syncOptions.url, 2048);
            const candidateUrl = requestedUrl || status.folderUrl;
            if (!candidateUrl) {
                throw new ConsumerBackupSyncError(
                    'SYNC_FOLDER_NOT_CONFIGURED',
                    'Configure uma pasta publica do Google Drive antes de sincronizar.',
                );
            }

            try {
                canonical = canonicalizeGoogleDriveFolderUrl(candidateUrl);
            } catch (error) {
                throw new ConsumerBackupSyncError(
                    'SYNC_FOLDER_URL_REQUIRED',
                    'A sincronizacao automatica aceita somente o link de uma pasta publica do Google Drive.',
                    { cause: error },
                );
            }

            configuredFolder = Boolean(status.folderId && canonical.folderId === status.folderId);
            persistOnSuccess = configuredFolder || syncOptions.save === true;

            checkedAt = normalizeNow(now);
            emitProgress(syncOptions.onProgress, 'folder-check', 'Consultando a pasta de backups no Google Drive...', 1);
            selected = await resolveSource(canonical.folderUrl);
            if (!selected || selected.sourceType !== 'folder' || selected.folderId !== canonical.folderId) {
                throw new ConsumerBackupSyncError(
                    'SYNC_FOLDER_RESULT_INVALID',
                    'A consulta da pasta nao retornou uma fonte valida de backup.',
                );
            }

            const parsedFileUrl = parseGoogleDriveSourceUrl(selected.fileUrl);
            const fileId = safeIdentifier(selected.fileId || parsedFileUrl.fileId);
            const fileUrl = fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
            const fileName = safeFileName(selected.fileName);
            const modifiedAt = safeIsoDate(selected.modifiedAt);
            if (parsedFileUrl.sourceType !== 'file' || !fileId || parsedFileUrl.fileId !== fileId
                || !fileName || !/\.(?:fbconsumer|fb|fbk|gbk|bak|backup)$/i.test(fileName)) {
                throw new ConsumerBackupSyncError(
                    'SYNC_BACKUP_RESULT_INVALID',
                    'A pasta nao retornou um backup Firebird ou .fbconsumer valido.',
                );
            }

            const sameFile = modifiedAt !== null
                && status.lastFileId === fileId
                && status.lastModifiedAt === modifiedAt
                && TERMINAL_STATUSES.has(status.lastStatus);
            if (sameFile) {
                const next = {
                    ...status,
                    enabled: status.enabled || syncOptions.save === true,
                    folderUrl: syncOptions.save === true ? canonical.folderUrl : status.folderUrl,
                    folderId: syncOptions.save === true ? canonical.folderId : status.folderId,
                    lastCheckedAt: checkedAt,
                    lastFileId: fileId,
                    lastFileName: fileName,
                    lastModifiedAt: modifiedAt,
                    lastStatus: 'up_to_date',
                    lastError: null,
                };
                if (persistOnSuccess) status = await persist(next);
                emitProgress(syncOptions.onProgress, 'completed', 'O backup mais novo ja esta sincronizado.', 100);
                return {
                    status: 'up_to_date',
                    reason,
                    checkedAt,
                    folderId: canonical.folderId,
                    folderUrl: canonical.folderUrl,
                    fileId,
                    fileName,
                    modifiedAt,
                    importacaoId: status.lastImportId,
                    sha256: status.lastSha256,
                };
            }

            emitProgress(syncOptions.onProgress, 'folder-download', 'Novo backup encontrado; iniciando a importacao...', 2);
            const importResult = await importBackup({
                url: fileUrl,
                sourceKind: 'drive-folder',
                sourceName: fileName,
                driveFileId: fileId,
                backupCreatedAt: safeSourceDate(selected.backupTimestamp) || modifiedAt,
                onProgress: syncOptions.onProgress,
            });
            const importStatus = normalizeImportStatus(importResult);
            const importId = safeText(importResult?.importacaoId || importResult?.importId, 200) || status.lastImportId;
            const sha256 = safeHash(importResult?.sha256 || importResult?.assinatura) || status.lastSha256;
            const syncedAt = TERMINAL_STATUSES.has(importStatus) ? checkedAt : status.lastSyncedAt;
            const next = {
                ...status,
                enabled: status.enabled || syncOptions.save === true,
                folderUrl: syncOptions.save === true ? canonical.folderUrl : status.folderUrl,
                folderId: syncOptions.save === true ? canonical.folderId : status.folderId,
                lastCheckedAt: checkedAt,
                lastSyncedAt: syncedAt,
                lastFileId: fileId,
                lastFileName: fileName,
                lastModifiedAt: modifiedAt,
                lastStatus: importStatus,
                lastImportId: importId,
                lastSha256: sha256,
                lastError: null,
            };
            if (persistOnSuccess) status = await persist(next);

            return {
                ...importResult,
                status: importStatus,
                reason,
                checkedAt,
                folderId: canonical.folderId,
                folderUrl: canonical.folderUrl,
                fileId,
                fileName,
                modifiedAt,
                importResult,
            };
        } catch (error) {
            const errorAt = checkedAt || normalizeNow(now);
            const stableStatus = storedStatus || readStoredStatus();
            const next = {
                ...stableStatus,
                lastCheckedAt: errorAt,
                lastStatus: 'error',
                lastError: safeErrorMessage(error),
                ...(selected ? {
                    lastFileId: safeIdentifier(selected.fileId) || stableStatus.lastFileId,
                    lastFileName: safeFileName(selected.fileName) || stableStatus.lastFileName,
                    lastModifiedAt: safeIsoDate(selected.modifiedAt) || stableStatus.lastModifiedAt,
                } : {}),
            };
            if (configuredFolder) {
                try {
                    await persist(next);
                } catch (saveError) {
                    throw new ConsumerBackupSyncError(
                        'SYNC_CONFIG_SAVE_FAILED',
                        'A sincronizacao falhou e o aplicativo nao conseguiu salvar o estado da tentativa.',
                        { cause: saveError },
                    );
                }
            } else {
                status = stableStatus;
            }
            throw error;
        } finally {
            running = false;
            publishStatus();
        }
    }

    function getStatus() {
        return {
            ...status,
            running,
            scheduled: Boolean(timer),
        };
    }

    function start(startOptions = {}) {
        if (timer) {
            return {
                started: false,
                reason: 'already_started',
                intervalMs: intervalOverride || (status.intervalMinutes * 60 * 1000),
                initialCheck: Promise.resolve(null),
            };
        }

        status = readStoredStatus();
        if (running) {
            return {
                started: false,
                reason: 'busy',
                intervalMs: null,
                initialCheck: Promise.resolve(null),
            };
        }
        if (!status.enabled || !status.folderUrl) {
            return {
                started: false,
                reason: 'disabled',
                intervalMs: null,
                initialCheck: Promise.resolve(null),
            };
        }

        const delay = intervalOverride || (status.intervalMinutes * 60 * 1000);
        const runAutomatic = async () => {
            try {
                const result = await sync({ reason: 'automatic', onProgress: startOptions.onProgress });
                if (typeof startOptions.onResult === 'function') {
                    try { startOptions.onResult(result); } catch { /* callback externo */ }
                }
                return result;
            } catch (error) {
                if (typeof startOptions.onError === 'function') {
                    try { startOptions.onError(error); } catch { /* callback externo */ }
                }
                return null;
            }
        };

        timer = setInterval(() => { void runAutomatic(); }, delay);
        timer.unref?.();
        const initialCheck = startOptions.immediate === false ? Promise.resolve(null) : runAutomatic();
        return {
            started: true,
            intervalMs: delay,
            unrefed: typeof timer.hasRef === 'function' ? !timer.hasRef() : null,
            initialCheck,
        };
    }

    function stop() {
        if (!timer) return false;
        clearInterval(timer);
        timer = null;
        return true;
    }

    async function disable() {
        if (running) {
            throw new ConsumerBackupSyncError(
                'SYNC_ALREADY_RUNNING',
                'Aguarde a sincronizacao em andamento antes de remover a pasta.',
            );
        }
        stop();
        status = readStoredStatus();
        return persist({
            ...status,
            enabled: false,
            folderUrl: null,
            folderId: null,
            lastError: null,
        });
    }

    function onStatus(listener) {
        if (typeof listener !== 'function') throw new TypeError('onStatus requer uma funcao.');
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
    }

    return {
        sync,
        getStatus,
        onStatus,
        start,
        stop,
        disable,
    };
}

module.exports = {
    DEFAULT_SYNC_INTERVAL_MINUTES,
    ConsumerBackupSyncError,
    canonicalizeGoogleDriveFolderUrl,
    normalizeConsumerBackupSyncConfig,
    createConsumerBackupSyncService,
};
