const fs = require('fs');
const path = require('path');
const database = require('./database');
const { readImportRows, inferListKind, SUPPORTED_EXTENSIONS } = require('./importer');

const FORMAT_PRIORITY = { '.xlsx': 4, '.xls': 3, '.csv': 2, '.pdf': 1 };

function defaultListsDirectory() {
    const candidates = [
        process.env.VALEVERDE_LISTS_DIR,
        path.join(process.cwd(), 'listas'),
        process.resourcesPath ? path.join(process.resourcesPath, 'listas') : '',
        path.join(__dirname, '..', 'listas'),
    ].filter(Boolean);
    return candidates.find((directory) => fs.existsSync(directory)) || candidates[0];
}

const LISTS_DIR = defaultListsDirectory();

function normalized(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function mirrorKey(fileName) {
    const name = normalized(path.basename(fileName, path.extname(fileName)));
    return name.replace(/(?:xlsx|xls|csv|excel|exel|pdf|pds)$/i, '') || name;
}

function signature(stats) {
    return `${Math.round(stats.mtimeMs)}:${stats.size}`;
}

function listFiles(directory = LISTS_DIR) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const filePath = path.join(directory, entry.name);
            const extension = path.extname(entry.name).toLowerCase();
            return { filePath, name: entry.name, extension, stats: fs.statSync(filePath) };
        })
        .filter((file) => SUPPORTED_EXTENSIONS.includes(file.extension));
}

function selectCanonicalFile(files) {
    return [...files].sort((a, b) => {
        const priority = (FORMAT_PRIORITY[b.extension] || 0) - (FORMAT_PRIORITY[a.extension] || 0);
        if (priority) return priority;
        return b.stats.mtimeMs - a.stats.mtimeMs;
    })[0];
}

function groupFiles(files) {
    const groups = new Map();
    files.forEach((file) => {
        const key = mirrorKey(file.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(file);
    });
    return [...groups.entries()].map(([key, entries]) => ({ key, entries, selected: selectCanonicalFile(entries) }));
}

function priorImportById() {
    return new Map(database.listImports().map((item) => [item.id, item]));
}

async function synchronizeLists(directory = LISTS_DIR) {
    const files = listFiles(directory);
    const previous = priorImportById();
    const result = {
        diretorio: directory,
        encontrados: files.length,
        processados: 0,
        ignorados: 0,
        erros: 0,
        detalhes: [],
    };

    for (const group of groupFiles(files)) {
        const file = group.selected;
        const id = `lista:${group.key}`;
        const currentSignature = signature(file.stats);
        const previousImport = previous.get(id);
        if (previousImport?.assinatura === currentSignature && previousImport.status === 'concluida') {
            result.ignorados += 1;
            result.detalhes.push({ arquivo: file.name, tipo: previousImport.tipo, status: 'inalterado' });
            continue;
        }

        try {
            const parsed = await readImportRows(file.filePath);
            const tipo = inferListKind(file.filePath, parsed.rows);
            const imported = tipo === 'produtos'
                ? database.importProducts(parsed.rows, file.name)
                : database.importCustomers(parsed.rows, file.name);
            const metadata = database.saveImportMetadata({
                id,
                arquivo: file.name,
                tipo,
                formato: file.extension.slice(1).toUpperCase(),
                assinatura: currentSignature,
                status: 'concluida',
                totalLido: parsed.rows.length,
                created: imported.created,
                updated: imported.updated,
                ignored: imported.ignored,
                erro: '',
            });
            result.processados += 1;
            result.detalhes.push(metadata);
        } catch (error) {
            const metadata = database.saveImportMetadata({
                id,
                arquivo: file.name,
                tipo: inferListKind(file.filePath),
                formato: file.extension.slice(1).toUpperCase(),
                assinatura: currentSignature,
                status: 'erro',
                erro: String(error.message || error),
            });
            result.erros += 1;
            result.detalhes.push(metadata);
        }
    }
    return result;
}

module.exports = {
    LISTS_DIR,
    synchronizeLists,
    listFiles,
    mirrorKey,
};
