'use strict';

const path = require('node:path');

const {
    DownloadError,
    extractGoogleDriveFileId,
} = require('./google-drive-download');

const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_FOLDER_HTML_BYTES = 8 * 1024 * 1024;
const MIN_DRIVE_ID_LENGTH = 10;
const MAX_DRIVE_ID_LENGTH = 200;
const LOCAL_BACKUP_OFFSET = '-03:00';

function validateDriveId(value, code, message) {
    const id = String(value || '');
    const expression = new RegExp(`^[A-Za-z0-9_-]{${MIN_DRIVE_ID_LENGTH},${MAX_DRIVE_ID_LENGTH}}$`);
    if (!expression.test(id)) throw new DownloadError(message, code);
    return id;
}

function parseGoogleDriveSourceUrl(input) {
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

    const folderMatch = url.pathname.match(/\/(?:drive(?:\/u\/\d+)?\/)?folders\/([^/]+)/i);
    if (folderMatch) {
        return {
            sourceType: 'folder',
            folderId: validateDriveId(
                folderMatch[1],
                'DRIVE_FOLDER_ID_INVALID',
                'Nao foi possivel identificar a pasta no link do Google Drive.',
            ),
        };
    }

    return {
        sourceType: 'file',
        fileId: extractGoogleDriveFileId(raw),
    };
}

function extractGoogleDriveFolderId(input) {
    const parsed = parseGoogleDriveSourceUrl(input);
    if (parsed.sourceType !== 'folder') {
        throw new DownloadError('O link informado nao e de uma pasta do Google Drive.', 'DRIVE_FOLDER_URL_REQUIRED');
    }
    return parsed.folderId;
}

function buildFolderUrl(folderId) {
    const safeId = validateDriveId(
        folderId,
        'DRIVE_FOLDER_ID_INVALID',
        'Nao foi possivel identificar a pasta no link do Google Drive.',
    );
    return new URL(`https://drive.google.com/drive/folders/${safeId}`);
}

function buildFileViewUrl(fileId) {
    const safeId = validateDriveId(
        fileId,
        'DRIVE_FILE_ID_INVALID',
        'Nao foi possivel identificar o arquivo no link do Google Drive.',
    );
    return `https://drive.google.com/file/d/${safeId}/view`;
}

// Decodifica somente os escapes de uma string JavaScript. Nao executa o
// conteudo recebido do Drive e, portanto, nao usa eval/Function/VM.
function decodeDriveJsString(encoded) {
    const source = String(encoded || '');
    let output = '';

    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (character !== '\\') {
            output += character;
            continue;
        }

        const escape = source[index + 1];
        if (escape === undefined) {
            throw new DownloadError('A listagem da pasta do Google Drive esta incompleta.', 'DRIVE_FOLDER_FORMAT_CHANGED');
        }
        index += 1;

        if (escape === 'x') {
            const hex = source.slice(index + 1, index + 3);
            if (!/^[0-9a-f]{2}$/i.test(hex)) {
                throw new DownloadError('A listagem da pasta do Google Drive possui formato invalido.', 'DRIVE_FOLDER_FORMAT_CHANGED');
            }
            output += String.fromCharCode(Number.parseInt(hex, 16));
            index += 2;
            continue;
        }

        if (escape === 'u') {
            const hex = source.slice(index + 1, index + 5);
            if (!/^[0-9a-f]{4}$/i.test(hex)) {
                throw new DownloadError('A listagem da pasta do Google Drive possui formato invalido.', 'DRIVE_FOLDER_FORMAT_CHANGED');
            }
            output += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            continue;
        }

        if (escape === '\n') continue;
        if (escape === '\r') {
            if (source[index + 1] === '\n') index += 1;
            continue;
        }

        const simpleEscapes = {
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
            v: '\v',
            0: '\0',
        };
        output += Object.prototype.hasOwnProperty.call(simpleEscapes, escape)
            ? simpleEscapes[escape]
            : escape;
    }

    return output;
}

function extractDriveFolderPayload(html) {
    const source = String(html || '');
    const marker = "window['_DRIVE_ivd']";
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
        throw new DownloadError(
            'Nao foi possivel listar a pasta. Libere o acesso para quem possui o link.',
            'DRIVE_FOLDER_NOT_PUBLIC',
        );
    }

    const assignmentIndex = source.indexOf('=', markerIndex + marker.length);
    if (assignmentIndex < 0) {
        throw new DownloadError('O Google Drive alterou o formato da listagem da pasta.', 'DRIVE_FOLDER_FORMAT_CHANGED');
    }

    let quoteIndex = assignmentIndex + 1;
    while (/\s/.test(source[quoteIndex] || '')) quoteIndex += 1;
    const quote = source[quoteIndex];
    if (quote !== "'" && quote !== '"') {
        throw new DownloadError('O Google Drive alterou o formato da listagem da pasta.', 'DRIVE_FOLDER_FORMAT_CHANGED');
    }

    let escaped = false;
    let endIndex = -1;
    for (let index = quoteIndex + 1; index < source.length; index += 1) {
        const character = source[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === '\\') {
            escaped = true;
            continue;
        }
        if (character === quote) {
            endIndex = index;
            break;
        }
    }

    if (endIndex < 0) {
        throw new DownloadError('A listagem da pasta do Google Drive esta incompleta.', 'DRIVE_FOLDER_FORMAT_CHANGED');
    }

    const encoded = source.slice(quoteIndex + 1, endIndex);
    if (!encoded || encoded.length > MAX_FOLDER_HTML_BYTES) {
        throw new DownloadError('A listagem da pasta do Google Drive excede o limite permitido.', 'DRIVE_FOLDER_TOO_LARGE');
    }

    try {
        return JSON.parse(decodeDriveJsString(encoded));
    } catch (error) {
        if (error instanceof DownloadError) throw error;
        throw new DownloadError('O Google Drive retornou uma listagem de pasta invalida.', 'DRIVE_FOLDER_FORMAT_CHANGED');
    }
}

function safeFileName(value) {
    const normalized = String(value || '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    const baseName = path.win32.basename(normalized.replace(/\//g, '\\')).slice(0, 240);
    return baseName && baseName !== '.' && baseName !== '..' ? baseName : '';
}

function epochToIso(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
    const date = new Date(milliseconds);
    const year = date.getUTCFullYear();
    if (!Number.isFinite(date.getTime()) || year < 2000 || year > 2200) return null;
    return date.toISOString();
}

function parseBackupTimestampFromName(fileName) {
    const match = String(fileName || '').match(/^bkp[^/\\]*?(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[^0-9]|$)/i);
    if (!match) return null;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
    const [year, month, day, hour, minute, second] = parts;
    if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31
        || hour > 23 || minute > 59 || second > 59) return null;

    const naiveTime = Date.UTC(year, month - 1, day, hour, minute, second);
    const validation = new Date(naiveTime);
    if (validation.getUTCFullYear() !== year || validation.getUTCMonth() !== month - 1
        || validation.getUTCDate() !== day || validation.getUTCHours() !== hour
        || validation.getUTCMinutes() !== minute || validation.getUTCSeconds() !== second) return null;

    return {
        value: `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${LOCAL_BACKUP_OFFSET}`,
        comparableTime: Date.parse(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${LOCAL_BACKUP_OFFSET}`),
    };
}

function isBackupFileName(fileName) {
    return /\.(?:fbconsumer|fb|fbk|gbk|bak|backup)$/i.test(String(fileName || ''));
}

function folderItemToFile(item) {
    if (!Array.isArray(item) || item[3] === DRIVE_FOLDER_MIME_TYPE) return null;

    let fileId;
    try {
        fileId = validateDriveId(
            item[0],
            'DRIVE_FILE_ID_INVALID',
            'A pasta contem um arquivo com identificador invalido.',
        );
    } catch {
        return null;
    }

    const fileName = safeFileName(item[2]);
    if (!fileName || !isBackupFileName(fileName)) return null;

    const modifiedAt = epochToIso(item[10]);
    const modifiedTime = modifiedAt ? Date.parse(modifiedAt) : null;
    const backupTimestamp = parseBackupTimestampFromName(fileName);
    const rawSize = Number(item[13]);
    const sizeBytes = Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : null;

    return {
        fileId,
        fileName,
        modifiedAt,
        sizeBytes,
        mimeType: typeof item[3] === 'string' ? item[3] : null,
        backupTimestamp: backupTimestamp?.value || null,
        timestampSource: backupTimestamp ? 'filename' : (modifiedAt ? 'modifiedTime' : null),
        selectionTimestamp: backupTimestamp?.comparableTime ?? modifiedTime,
        fileUrl: buildFileViewUrl(fileId),
    };
}

function parsePublicFolderHtml(html) {
    const payload = extractDriveFolderPayload(html);
    if (!Array.isArray(payload) || (payload[0] !== null && !Array.isArray(payload[0]))) {
        throw new DownloadError('O Google Drive retornou uma listagem de pasta invalida.', 'DRIVE_FOLDER_FORMAT_CHANGED');
    }

    // O HTML publico traz somente o primeiro lote quando a pasta possui mais
    // itens. O cursor restante e consumido pelo site por uma API interna e nao
    // documentada; escolher um backup apenas desse lote poderia regredir os
    // dados silenciosamente. O contrato oficial paginado exige autenticacao,
    // portanto recusamos uma listagem incompleta em vez de adivinhar.
    const continuationStates = Array.isArray(payload[4]) ? payload[4] : [];
    const hasContinuation = continuationStates.some((state) => (
        Array.isArray(state)
        && Number.isSafeInteger(Number(state[1]))
        && Number(state[1]) > 0
        && typeof state[3] === 'string'
        && state[3].trim().length > 0
    ));
    if (hasContinuation) {
        throw new DownloadError(
            'A pasta possui mais itens do que a listagem publica permite verificar. Deixe no maximo 50 itens, mova backups antigos para uma subpasta ou informe o link direto do arquivo mais recente.',
            'DRIVE_FOLDER_LIST_INCOMPLETE',
        );
    }

    return (payload[0] || []).map(folderItemToFile).filter(Boolean);
}

function selectNewestBackupFile(files) {
    const candidates = Array.isArray(files) ? files.filter((file) => file && isBackupFileName(file.fileName)) : [];
    if (!candidates.length) {
        throw new DownloadError(
            'A pasta compartilhada nao contem backups Firebird ou .fbconsumer.',
            'DRIVE_FOLDER_NO_BACKUPS',
        );
    }

    return [...candidates].sort((left, right) => {
        const leftTime = Number.isFinite(left.selectionTimestamp) ? left.selectionTimestamp : Number.NEGATIVE_INFINITY;
        const rightTime = Number.isFinite(right.selectionTimestamp) ? right.selectionTimestamp : Number.NEGATIVE_INFINITY;
        if (leftTime !== rightTime) return rightTime - leftTime;

        const leftModified = left.modifiedAt ? Date.parse(left.modifiedAt) : Number.NEGATIVE_INFINITY;
        const rightModified = right.modifiedAt ? Date.parse(right.modifiedAt) : Number.NEGATIVE_INFINITY;
        if (leftModified !== rightModified) return rightModified - leftModified;

        const nameOrder = String(right.fileName).localeCompare(String(left.fileName), 'pt-BR');
        return nameOrder || String(right.fileId).localeCompare(String(left.fileId));
    })[0];
}

async function readLimitedResponseText(response, maxBytes) {
    const contentLength = Number(response?.headers?.get?.('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new DownloadError('A listagem da pasta do Google Drive excede o limite permitido.', 'DRIVE_FOLDER_TOO_LARGE');
    }

    if (!response?.body?.getReader) {
        const text = await response.text();
        if (Buffer.byteLength(text) > maxBytes) {
            throw new DownloadError('A listagem da pasta do Google Drive excede o limite permitido.', 'DRIVE_FOLDER_TOO_LARGE');
        }
        return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let total = 0;
    let text = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new DownloadError('A listagem da pasta do Google Drive excede o limite permitido.', 'DRIVE_FOLDER_TOO_LARGE');
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

async function listPublicGoogleDriveFolder(folderId, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new DownloadError('O aplicativo nao possui suporte a consulta HTTPS.', 'FETCH_UNAVAILABLE');
    }

    const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const maxHtmlBytes = Number(options.maxHtmlBytes || MAX_FOLDER_HTML_BYTES);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(buildFolderUrl(folderId), {
            redirect: 'follow',
            signal: controller.signal,
            cache: 'no-store',
            headers: {
                accept: 'text/html,application/xhtml+xml',
                'user-agent': 'ValeVerdeDashboard/1.0',
            },
        });

        if (!response?.ok) {
            throw new DownloadError(
                `O Google Drive recusou a listagem da pasta (HTTP ${response?.status || 0}). Verifique o compartilhamento.`,
                'DRIVE_FOLDER_HTTP_ERROR',
            );
        }

        if (response.url) {
            let finalHost = '';
            try {
                finalHost = new URL(response.url).hostname.toLowerCase().replace(/^www\./, '');
            } catch {
                // Uma URL final malformada deve ser tratada como pasta inacessivel.
            }
            if (finalHost && finalHost !== 'drive.google.com') {
                throw new DownloadError(
                    'A pasta redirecionou para uma pagina de acesso. Libere-a para quem possui o link.',
                    'DRIVE_FOLDER_NOT_PUBLIC',
                );
            }
        }

        const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
        if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
            throw new DownloadError('O Google Drive nao retornou uma listagem de pasta valida.', 'DRIVE_FOLDER_FORMAT_CHANGED');
        }

        return parsePublicFolderHtml(await readLimitedResponseText(response, maxHtmlBytes));
    } catch (error) {
        if (error instanceof DownloadError) throw error;
        if (error?.name === 'AbortError') {
            throw new DownloadError('A consulta da pasta excedeu o tempo limite.', 'DRIVE_FOLDER_TIMEOUT');
        }
        throw new DownloadError(`Nao foi possivel consultar a pasta do Google Drive: ${error?.message || error}`, 'DRIVE_FOLDER_FAILED');
    } finally {
        clearTimeout(timer);
    }
}

async function resolveGoogleDriveBackupSource(input, options = {}) {
    const parsed = parseGoogleDriveSourceUrl(input);
    if (parsed.sourceType === 'file') {
        return {
            sourceType: 'file',
            folderId: null,
            fileId: parsed.fileId,
            fileName: null,
            modifiedAt: null,
            sizeBytes: null,
            backupTimestamp: null,
            timestampSource: null,
            fileUrl: buildFileViewUrl(parsed.fileId),
        };
    }

    const files = await listPublicGoogleDriveFolder(parsed.folderId, options);
    const newest = selectNewestBackupFile(files);
    return {
        sourceType: 'folder',
        folderId: parsed.folderId,
        ...newest,
    };
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    MAX_FOLDER_HTML_BYTES,
    extractGoogleDriveFolderId,
    parseGoogleDriveSourceUrl,
    buildFolderUrl,
    buildFileViewUrl,
    decodeDriveJsString,
    parseBackupTimestampFromName,
    parsePublicFolderHtml,
    selectNewestBackupFile,
    listPublicGoogleDriveFolder,
    resolveGoogleDriveBackupSource,
};
