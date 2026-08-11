const fs = require('fs');
const path = require('path');
const { upsertCustomers, normalizeCustomer } = require('./customer-utils');
const { upsertProducts, normalizeProduct } = require('./product-utils');

const DATA_DIR = process.env.VALEVERDE_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'valeverde-db.json');
const REPORTS_DIR = process.env.VALEVERDE_REPORTS_DIR || path.join(__dirname, '..', 'reports');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function createEmptyDb() {
    return {
        version: 2,
        clientes: [],
        produtos: [],
        relatorios: [],
        importacoes: [],
        configuracoes: {},
    };
}

function readDb() {
    ensureDir(DATA_DIR);
    if (!fs.existsSync(DB_PATH)) return createEmptyDb();

    try {
        const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        return {
            ...createEmptyDb(),
            ...parsed,
            clientes: Array.isArray(parsed.clientes) ? parsed.clientes : [],
            produtos: Array.isArray(parsed.produtos) ? parsed.produtos : [],
            relatorios: Array.isArray(parsed.relatorios) ? parsed.relatorios : [],
            importacoes: Array.isArray(parsed.importacoes) ? parsed.importacoes : [],
            configuracoes: parsed.configuracoes && typeof parsed.configuracoes === 'object' ? parsed.configuracoes : {},
        };
    } catch (error) {
        const backup = `${DB_PATH}.corrompido-${Date.now()}`;
        fs.renameSync(DB_PATH, backup);
        return createEmptyDb();
    }
}

function writeDb(db) {
    ensureDir(DATA_DIR);
    const tmpPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmpPath, DB_PATH);
}

function listCustomers() {
    return readDb().clientes.map((customer) => normalizeCustomer(customer, { keepRaw: false })).filter(Boolean);
}

function saveCustomers(clientes) {
    const db = readDb();
    db.clientes = clientes.map((customer) => normalizeCustomer(customer, { keepRaw: false })).filter(Boolean);
    writeDb(db);
    return db.clientes;
}

function importCustomers(rows, source = '') {
    const db = readDb();
    const result = upsertCustomers(db.clientes, rows, { source, keepRaw: true });
    db.clientes = result.customers;
    writeDb(db);
    return result;
}

function listProducts() {
    return readDb().produtos.map((product) => normalizeProduct(product, { keepRaw: false })).filter(Boolean);
}

function saveProducts(produtos) {
    const db = readDb();
    db.produtos = produtos.map((product) => normalizeProduct(product, { keepRaw: false })).filter(Boolean);
    writeDb(db);
    return db.produtos;
}

function importProducts(rows, source = '') {
    const db = readDb();
    const result = upsertProducts(db.produtos, rows, { source, keepRaw: true });
    db.produtos = result.products;
    writeDb(db);
    return result;
}

function listImports() {
    return readDb().importacoes.sort((a, b) => new Date(b.data) - new Date(a.data));
}

function saveImportMetadata(metadata = {}) {
    const db = readDb();
    const id = String(metadata.id || metadata.arquivo || `importacao:${Date.now()}`);
    const record = {
        id,
        data: new Date().toISOString(),
        arquivo: '',
        tipo: 'clientes',
        formato: '',
        assinatura: '',
        status: 'concluida',
        totalLido: 0,
        created: 0,
        updated: 0,
        ignored: 0,
        erro: '',
        ...metadata,
    };
    const position = db.importacoes.findIndex((item) => item.id === id);
    if (position >= 0) db.importacoes[position] = record;
    else db.importacoes.unshift(record);
    db.importacoes = db.importacoes.slice(0, 250);
    writeDb(db);
    return record;
}

function scanReportFiles() {
    ensureDir(REPORTS_DIR);
    return fs.readdirSync(REPORTS_DIR)
        .filter((name) => !name.startsWith('.') && /\.(csv|txt|xlsx)$/i.test(name))
        .map((name) => {
            const filePath = path.join(REPORTS_DIR, name);
            const stats = fs.statSync(filePath);
            return {
                id: `arquivo:${name}`,
                data: stats.mtime.toISOString(),
                tipo: 'arquivo',
                total: null,
                enviados: null,
                erros: null,
                ignorados: null,
                arquivo: name,
                arquivos: [name],
                origem: 'reports',
            };
        });
}

function listReports() {
    const db = readDb();
    const reportsByFile = new Set(
        db.relatorios.flatMap((report) => Array.isArray(report.arquivos) ? report.arquivos : [report.arquivo]).filter(Boolean)
    );

    const scanned = scanReportFiles().filter((report) => !report.arquivos.some((file) => reportsByFile.has(file)));
    return [...db.relatorios, ...scanned].sort((a, b) => new Date(b.data) - new Date(a.data));
}

function saveReportMetadata({ campanha = {}, resultados = [], arquivos = [] }) {
    const db = readDb();
    const enviados = resultados.filter((item) => /^Enviado/i.test(item.statusEnvio || '')).length;
    const ignorados = resultados.filter((item) => /^Ignorado/i.test(item.statusEnvio || '')).length;
    const erros = resultados.length - enviados - ignorados;
    const now = new Date().toISOString();
    const report = {
        id: `relatorio:${Date.now()}`,
        data: now,
        tipo: campanha.tipoEnvio || campanha.tipo || 'campanha',
        total: resultados.length,
        enviados,
        erros,
        ignorados,
        arquivos: arquivos.map((file) => path.basename(file)),
        origem: 'electron',
        mensagem: campanha.mensagem || '',
    };

    db.relatorios.unshift(report);
    writeDb(db);
    return report;
}

function getReport(id) {
    const report = listReports().find((item) => String(item.id) === String(id));
    if (!report) return null;

    const files = (report.arquivos || [report.arquivo]).filter(Boolean).map((name) => {
        const filePath = path.join(REPORTS_DIR, path.basename(name));
        if (!fs.existsSync(filePath)) return { nome: name, conteudo: '', indisponivel: true };
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.xlsx') return { nome: name, conteudo: '', binario: true };
        const content = fs.readFileSync(filePath, 'utf8');
        return { nome: name, conteudo: content.slice(0, 20000) };
    });

    return { ...report, arquivosDetalhe: files };
}

function getConfig() {
    return readDb().configuracoes;
}

function saveConfig(config) {
    const db = readDb();
    db.configuracoes = { ...db.configuracoes, ...config };
    writeDb(db);
    return db.configuracoes;
}

module.exports = {
    DB_PATH,
    REPORTS_DIR,
    listCustomers,
    saveCustomers,
    importCustomers,
    listProducts,
    saveProducts,
    importProducts,
    listImports,
    saveImportMetadata,
    listReports,
    saveReportMetadata,
    getReport,
    getConfig,
    saveConfig,
};
