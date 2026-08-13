'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const database = require('./database');
const importer = require('./importer');
const {
    MAX_BACKUP_BYTES,
    downloadGoogleDriveBackup,
} = require('./google-drive-download');
const { parseGoogleDriveSourceUrl } = require('./google-drive-folder');

const CONSUMER_BACKUP_EXTENSIONS = Object.freeze([
    '.fbconsumer',
    '.fb',
    '.fbk',
    '.gbk',
    '.bak',
    '.backup',
]);
const DOCUMENT_EXTENSIONS = Object.freeze(['.pdf', '.xls', '.xlsx', '.csv']);
const SUPPORTED_DATA_EXTENSIONS = Object.freeze([
    ...CONSUMER_BACKUP_EXTENSIONS,
    ...DOCUMENT_EXTENSIONS,
]);

class DataImportError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'DataImportError';
        this.code = code;
    }
}

function dataFileExtension(fileName) {
    return path.extname(String(fileName || '')).toLowerCase();
}

function classifyDataFile(fileName) {
    const extension = dataFileExtension(fileName);
    if (CONSUMER_BACKUP_EXTENSIONS.includes(extension)) {
        return { kind: 'consumer-backup', extension };
    }
    if (DOCUMENT_EXTENSIONS.includes(extension)) {
        return { kind: 'document', extension };
    }
    throw new DataImportError(
        'DATA_FILE_UNSUPPORTED',
        'Formato nao suportado. Selecione FB, FBCONSUMER, FBK, GBK, BAK, BACKUP, PDF, XLS, XLSX ou CSV.',
    );
}

function dataFileFormat(fileName, fallback = '') {
    const extension = dataFileExtension(fileName);
    if (SUPPORTED_DATA_EXTENSIONS.includes(extension)) return extension.slice(1).toUpperCase();
    return String(fallback || '').trim().toUpperCase();
}

function normalizeDocumentImportResult(filePath, parsed, imported, sourceKind) {
    const inferredType = parsed.tipo === 'produtos' ? 'produtos' : 'clientes';
    return {
        cancelado: false,
        arquivo: path.basename(filePath),
        formato: parsed.extension.slice(1).toUpperCase(),
        tipo: inferredType,
        tipoImportacao: inferredType,
        tipoFonte: sourceKind,
        totalLido: parsed.rows.length,
        invalidos: Number(imported.ignored || 0),
        ...imported,
    };
}

function documentSignature(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function importDocumentDataFile(filePath, options = {}) {
    const resolved = path.resolve(String(filePath || ''));
    const classification = classifyDataFile(resolved);
    if (classification.kind !== 'document') {
        throw new DataImportError('DOCUMENT_FILE_REQUIRED', 'Selecione um documento PDF, XLS, XLSX ou CSV.');
    }

    const importerImpl = options.importer || importer;
    const databaseImpl = options.database || database;
    const sourceName = safeDownloadedName(options.sourceName) || path.basename(resolved);
    const parsed = await importerImpl.readImportRows(resolved);
    const inferredType = importerImpl.inferListKind(sourceName, parsed.rows);
    if (!inferredType) {
        throw new DataImportError(
            'DATA_KIND_AMBIGUOUS',
            'Nao foi possivel identificar com seguranca se o arquivo contem clientes, devedores ou produtos. '
            + 'Revise os cabecalhos da tabela e tente novamente.',
        );
    }
    const imported = inferredType === 'produtos'
        ? databaseImpl.importProducts(parsed.rows, sourceName)
        : databaseImpl.importCustomers(parsed.rows, sourceName);
    const result = normalizeDocumentImportResult(
        sourceName,
        { ...parsed, tipo: inferredType },
        imported,
        options.sourceKind || 'local',
    );
    if (typeof databaseImpl.saveImportMetadata === 'function') {
        const signature = documentSignature(resolved);
        result.importacao = databaseImpl.saveImportMetadata({
            id: `arquivo:${signature}`,
            arquivo: sourceName,
            tipo: inferredType,
            formato: result.formato,
            assinatura: signature,
            status: 'concluida',
            totalLido: result.totalLido,
            created: Number(result.created || 0),
            updated: Number(result.updated || 0),
            ignored: Number(result.ignored || 0),
            erro: '',
        });
    }
    return result;
}

function safeDownloadedName(value) {
    const normalized = path.basename(String(value || '').replace(/[\u0000-\u001f]/g, '').trim());
    return normalized && normalized !== '.' && normalized !== '..' ? normalized.slice(0, 240) : '';
}

async function downloadGoogleDriveDataFile(url, options = {}) {
    const parsedUrl = parseGoogleDriveSourceUrl(url);
    if (parsedUrl.sourceType !== 'file') {
        throw new DataImportError(
            'DRIVE_FILE_URL_REQUIRED',
            'Este fluxo requer o link de um arquivo do Google Drive.',
        );
    }

    const temporaryRoot = path.resolve(options.tempRoot || os.tmpdir());
    const temporaryDirectory = await fsp.mkdtemp(path.join(temporaryRoot, 'valeverde-data-drive-'));
    const temporaryPath = path.join(temporaryDirectory, 'download.tmp');
    const downloader = options.downloader || downloadGoogleDriveBackup;

    try {
        const downloaded = await downloader(url, temporaryPath, {
            maxBytes: options.maxBytes || MAX_BACKUP_BYTES,
            onProgress: options.onProgress,
        });
        const fileName = safeDownloadedName(downloaded.fileName);
        const classification = classifyDataFile(fileName);
        const baseName = path.basename(fileName, classification.extension)
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
            .replace(/[. ]+$/g, '')
            .slice(0, 200) || 'arquivo';
        const finalPath = path.join(temporaryDirectory, `${baseName}${classification.extension}`);
        await fsp.rename(temporaryPath, finalPath);
        return {
            filePath: finalPath,
            fileName,
            fileId: downloaded.fileId || parsedUrl.fileId,
            modifiedAt: downloaded.modifiedAt || null,
            sizeBytes: Number(downloaded.sizeBytes || fs.statSync(finalPath).size),
            classification,
            temporaryDirectory,
        };
    } catch (error) {
        await fsp.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
            .catch(() => {});
        if (error instanceof DataImportError) throw error;
        throw new DataImportError(
            'DRIVE_DATA_DOWNLOAD_FAILED',
            `Nao foi possivel preparar o arquivo do Google Drive: ${error?.message || error}`,
            { cause: error },
        );
    }
}

async function removeDownloadedDataFile(downloaded) {
    const directory = downloaded?.temporaryDirectory;
    if (!directory) return;
    await fsp.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

module.exports = {
    CONSUMER_BACKUP_EXTENSIONS,
    DOCUMENT_EXTENSIONS,
    SUPPORTED_DATA_EXTENSIONS,
    DataImportError,
    classifyDataFile,
    dataFileFormat,
    importDocumentDataFile,
    downloadGoogleDriveDataFile,
    removeDownloadedDataFile,
};
