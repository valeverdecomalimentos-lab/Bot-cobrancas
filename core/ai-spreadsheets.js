const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readSpreadsheetRows, SPREADSHEET_EXTENSIONS } = require('./spreadsheet');

const cachedSources = new Map();
const supportedExtensions = new Set(SPREADSHEET_EXTENSIONS);
const MAX_FILE_SIZE = 30 * 1024 * 1024;

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function contentSignature(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function loadSpreadsheetSources(directory, options = {}) {
    if (!directory || !fs.existsSync(directory)) return [];
    const maxFiles = boundedInteger(options.maxFiles, 20, 1, 100);
    const maxRowsPerFile = boundedInteger(options.maxRowsPerFile, 25000, 100, 100000);
    const maxTotalRows = boundedInteger(options.maxTotalRows, 100000, 100, 300000);
    const entries = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => {
            const filePath = path.join(directory, entry.name);
            return { name: entry.name, filePath, stats: fs.statSync(filePath) };
        })
        .filter((entry) => entry.stats.size <= MAX_FILE_SIZE)
        .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)
        .slice(0, maxFiles);

    const activePaths = new Set(entries.map((entry) => entry.filePath));
    [...cachedSources.keys()].forEach((filePath) => {
        if (!activePaths.has(filePath)) cachedSources.delete(filePath);
    });

    const sources = [];
    let remainingRows = maxTotalRows;
    for (const entry of entries) {
        if (remainingRows <= 0) break;
        try {
            const signature = contentSignature(entry.filePath);
            let source = cachedSources.get(entry.filePath);
            if (!source || source.signature !== signature) {
                const rows = await readSpreadsheetRows(entry.filePath);
                source = {
                    name: entry.name,
                    signature,
                    updatedAt: entry.stats.mtime.toISOString(),
                    totalRows: rows.length,
                    rows: rows.slice(0, maxRowsPerFile),
                    truncated: rows.length > maxRowsPerFile,
                };
                cachedSources.set(entry.filePath, source);
            }
            const allowedRows = Math.min(source.rows.length, remainingRows);
            sources.push({ ...source, rows: source.rows.slice(0, allowedRows), truncated: source.truncated || allowedRows < source.rows.length });
            remainingRows -= allowedRows;
        } catch {
            cachedSources.delete(entry.filePath);
        }
    }
    return sources;
}

function clearSpreadsheetCache() {
    cachedSources.clear();
}

module.exports = {
    loadSpreadsheetSources,
    clearSpreadsheetCache,
};
