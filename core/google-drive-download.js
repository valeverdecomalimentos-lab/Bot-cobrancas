const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

class DownloadError extends Error {
    constructor(message, code = 'DOWNLOAD_FAILED') {
        super(message);
        this.name = 'DownloadError';
        this.code = code;
    }
}

function extractGoogleDriveFileId(input) {
    const raw = String(input || '').trim();
    if (!raw || raw.length > 2048) {
        throw new DownloadError('Informe um link valido do Google Drive.', 'DRIVE_URL_INVALID');
    }
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new DownloadError('Informe um link valido do Google Drive.', 'DRIVE_URL_INVALID');
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.protocol !== 'https:' || host !== 'drive.google.com') {
        throw new DownloadError('Use um link HTTPS compartilhado pelo Google Drive.', 'DRIVE_URL_INVALID');
    }
    if (/\/folders\//i.test(url.pathname)) {
        throw new DownloadError('O link informado e de uma pasta. Use o link do arquivo .fbconsumer.', 'DRIVE_FOLDER_URL');
    }

    const fileId = url.pathname.match(/\/file\/d\/([^/]+)/i)?.[1] || url.searchParams.get('id');
    if (!fileId || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
        throw new DownloadError('Nao foi possivel identificar o arquivo no link do Google Drive.', 'DRIVE_FILE_ID_INVALID');
    }
    return fileId;
}

function buildDownloadUrl(fileId) {
    const url = new URL('https://drive.usercontent.google.com/download');
    url.searchParams.set('id', fileId);
    url.searchParams.set('export', 'download');
    url.searchParams.set('confirm', 't');
    return url;
}

function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
        // A limpeza final e melhor esforco; o diretorio temporario pai tambem sera removido.
    }
}

function responseFileName(response) {
    const disposition = String(response?.headers?.get?.('content-disposition') || '');
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const plain = disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1];
    let value = encoded || plain || '';
    try {
        value = encoded ? decodeURIComponent(encoded) : value;
    } catch {
        value = '';
    }
    return path.basename(String(value).trim().replace(/[\u0000-\u001f]/g, '')).slice(0, 240);
}

function responseModifiedAt(response) {
    const value = String(response?.headers?.get?.('last-modified') || '').trim();
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function downloadGoogleDriveBackup(input, destinationPath, options = {}) {
    const fileId = extractGoogleDriveFileId(input);
    const maxBytes = Number(options.maxBytes || MAX_BACKUP_BYTES);
    const timeoutMs = Number(options.timeoutMs || REQUEST_TIMEOUT_MS);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new DownloadError('O aplicativo nao possui suporte a download HTTPS.', 'FETCH_UNAVAILABLE');

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetchImpl(buildDownloadUrl(fileId), {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'user-agent': 'ValeVerdeDashboard/1.0' },
        });
        if (!response.ok || !response.body) {
            throw new DownloadError(`O Google Drive recusou o download (HTTP ${response.status}). Verifique o compartilhamento do arquivo.`, 'DRIVE_HTTP_ERROR');
        }

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > maxBytes) throw new DownloadError('O backup excede o limite de 2 GB.', 'BACKUP_TOO_LARGE');
        if (contentType.includes('text/html')) {
            throw new DownloadError('O link abriu uma pagina do Google Drive em vez do arquivo. Libere o acesso para quem possui o link.', 'DRIVE_NOT_PUBLIC');
        }

        let received = 0;
        const counter = new Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                if (received > maxBytes) {
                    callback(new DownloadError('O backup excede o limite de 2 GB.', 'BACKUP_TOO_LARGE'));
                    return;
                }
                if (typeof options.onProgress === 'function') options.onProgress({ received, total: contentLength || null });
                callback(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }));
        if (!received) throw new DownloadError('O arquivo baixado esta vazio.', 'BACKUP_EMPTY');
        return {
            fileId,
            filePath: destinationPath,
            sizeBytes: received,
            fileName: responseFileName(response),
            modifiedAt: responseModifiedAt(response),
        };
    } catch (error) {
        safeUnlink(destinationPath);
        if (error instanceof DownloadError) throw error;
        if (error?.name === 'AbortError') throw new DownloadError('O download excedeu o tempo limite.', 'DOWNLOAD_TIMEOUT');
        throw new DownloadError(`Nao foi possivel baixar o backup: ${error?.message || error}`, 'DOWNLOAD_FAILED');
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    MAX_BACKUP_BYTES,
    DownloadError,
    extractGoogleDriveFileId,
    buildDownloadUrl,
    responseFileName,
    responseModifiedAt,
    downloadGoogleDriveBackup,
};
