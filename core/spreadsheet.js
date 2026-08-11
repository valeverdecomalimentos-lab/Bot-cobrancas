const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { cleanText } = require('./customer-utils');

const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const HEADER_SCAN_LIMIT = 24;

function normalizeHeader(value) {
    return cleanText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function detectCsvEncoding(buffer) {
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) return 'utf16le';
    if (buffer[0] === 0xFE && buffer[1] === 0xFF) return 'utf16be';
    if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return 'utf8';
    return buffer.toString('utf8').includes('\uFFFD') ? 'latin1' : 'utf8';
}

function decodeCsv(buffer) {
    const encoding = detectCsvEncoding(buffer);
    if (encoding === 'utf16be') {
        const swapped = Buffer.from(buffer);
        for (let index = 0; index + 1 < swapped.length; index += 2) {
            const current = swapped[index];
            swapped[index] = swapped[index + 1];
            swapped[index + 1] = current;
        }
        return swapped.toString('utf16le').replace(/^\uFEFF/, '');
    }
    return buffer.toString(encoding).replace(/^\uFEFF/, '');
}

function detectCsvDelimiter(text) {
    const sample = String(text || '').slice(0, 16000).split(/\r?\n/)[0] || '';
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let quoted = false;
    for (let index = 0; index < sample.length; index += 1) {
        const character = sample[index];
        if (character === '"') {
            if (quoted && sample[index + 1] === '"') index += 1;
            else quoted = !quoted;
        } else if (!quoted && Object.hasOwn(counts, character)) {
            counts[character] += 1;
        }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function headerScore(row) {
    const headers = row.map(normalizeHeader).filter(Boolean);
    if (headers.length < 2) return 0;
    const terms = [
        'nome', 'cliente', 'telefone', 'celular', 'whatsapp', 'cpf', 'email', 'endereco',
        'saldo', 'divida', 'debito', 'situacao', 'status', 'limite',
        'produto', 'categoria', 'codigo', 'cod', 'preco', 'custo', 'venda', 'estoque', 'medida',
    ];
    const matches = new Set();
    headers.forEach((header) => terms.forEach((term) => {
        if (header.includes(term)) matches.add(term);
    }));
    return matches.size * 10 + Math.min(headers.length, 12);
}

function selectHeaderRow(grid) {
    let best = { index: 0, score: -1 };
    grid.slice(0, HEADER_SCAN_LIMIT).forEach((row, index) => {
        const score = headerScore(Array.isArray(row) ? row : []);
        if (score > best.score) best = { index, score };
    });
    return best.score >= 20 ? best.index : 0;
}

function uniqueHeaders(row) {
    const used = new Map();
    return row.map((value, index) => {
        const candidate = cleanText(value) || `coluna_${index + 1}`;
        const count = (used.get(candidate) || 0) + 1;
        used.set(candidate, count);
        return count === 1 ? candidate : `${candidate}_${count}`;
    });
}

function valueFromCell(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    return value;
}

function rowsFromSheet(sheet) {
    const grid = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: '',
        raw: false,
        blankrows: false,
        dateNF: 'yyyy-mm-dd',
    });
    if (grid.length < 2) return [];

    const headerRow = selectHeaderRow(grid);
    const headers = uniqueHeaders(grid[headerRow]);
    const rows = [];
    for (let index = headerRow + 1; index < grid.length; index += 1) {
        const source = grid[index];
        const record = {};
        let hasValue = false;
        headers.forEach((header, columnIndex) => {
            const value = valueFromCell(source[columnIndex]);
            record[header] = value;
            if (cleanText(value)) hasValue = true;
        });
        if (hasValue) rows.push(record);
    }
    return rows;
}

function readWorkbook(filePath) {
    const extension = path.extname(filePath || '').toLowerCase();
    if (extension === '.csv') {
        const content = decodeCsv(fs.readFileSync(filePath));
        return XLSX.read(content, {
            type: 'string',
            FS: detectCsvDelimiter(content),
            raw: false,
            cellDates: true,
        });
    }
    return XLSX.readFile(filePath, { cellDates: true, raw: false });
}

async function readSpreadsheetRows(filePath) {
    const extension = path.extname(filePath || '').toLowerCase();
    if (!SPREADSHEET_EXTENSIONS.has(extension)) {
        throw new Error('Formato de planilha nao suportado. Use XLS, XLSX ou CSV.');
    }

    const workbook = readWorkbook(filePath);
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];
    return rowsFromSheet(workbook.Sheets[firstSheetName]);
}

module.exports = {
    SPREADSHEET_EXTENSIONS: [...SPREADSHEET_EXTENSIONS],
    readSpreadsheetRows,
    normalizeHeader,
    headerScore,
};
