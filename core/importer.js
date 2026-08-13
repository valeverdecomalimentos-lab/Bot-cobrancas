const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { normalizeCustomer, upsertCustomers, cleanText } = require('./customer-utils');
const { readSpreadsheetRows, normalizeHeader } = require('./spreadsheet');

const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv', '.pdf']);
const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;
const MAX_ROWS = 100000;

function assertSupportedFile(filePath) {
    const extension = path.extname(filePath || '').toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
        throw new Error('Formato nao suportado. Selecione um arquivo XLS, XLSX, CSV ou PDF.');
    }
    if (!fs.existsSync(filePath)) throw new Error('Arquivo selecionado nao foi encontrado.');
    if (fs.statSync(filePath).size > MAX_FILE_SIZE_BYTES) {
        throw new Error('O arquivo excede o limite de 30 MB para importacao.');
    }
    return extension;
}

function splitPdfColumns(line) {
    const original = String(line || '').trim();
    if (!original) return [];
    if (original.includes('|')) return original.split('|').map(cleanText).filter(Boolean);
    if (original.includes('\t')) return original.split('\t').map(cleanText).filter(Boolean);
    if (original.includes(';')) return original.split(';').map(cleanText).filter(Boolean);
    return original.split(/\s{2,}/).map(cleanText).filter(Boolean);
}

function headerScore(columns) {
    const text = columns.map(normalizeHeader).join(' ');
    let score = 0;
    if (/(nome|cliente|razaosocial|produto)/.test(text)) score += 1;
    if (/(telefone|celular|whatsapp|contato|fone)/.test(text)) score += 1;
    if (/(cpf|documento)/.test(text)) score += 1;
    if (/(valor|saldo|divida|debito|devido|preco|custo|venda)/.test(text)) score += 1;
    if (/(status|situacao|estado|estoque|categoria|codigo)/.test(text)) score += 1;
    return score;
}

function rowsFromHeaderTable(lines) {
    const headerIndex = lines.findIndex((line) => {
        const columns = splitPdfColumns(line);
        return columns.length >= 2 && headerScore(columns) >= 2;
    });
    if (headerIndex < 0) return [];

    const headers = splitPdfColumns(lines[headerIndex]).map((header, index) => header || `coluna_${index + 1}`);
    const rows = [];

    for (let index = headerIndex + 1; index < lines.length; index += 1) {
        const columns = splitPdfColumns(lines[index]);
        if (columns.length < 2 || headerScore(columns) >= 2) continue;
        if (columns.length > headers.length) {
            const firstColumns = columns.slice(0, headers.length - 1);
            firstColumns.push(columns.slice(headers.length - 1).join(' '));
            columns.splice(0, columns.length, ...firstColumns);
        }
        if (columns.length !== headers.length) continue;

        const row = {};
        headers.forEach((header, columnIndex) => { row[header] = columns[columnIndex]; });
        rows.push(row);
        if (rows.length > MAX_ROWS) throw new Error('O PDF possui mais de 100.000 linhas. Divida o arquivo antes de importar.');
    }
    return rows;
}

function rowsFromInlinePdfRecords(lines) {
    const phonePattern = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9?\d{4})[-\s]?\d{4}/;
    const moneyPattern = /(?:R\$\s*)?(?:(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}|\d+(?:\.\d{2}))/i;
    const rows = [];

    lines.forEach((line) => {
        const phoneMatch = line.match(phonePattern);
        if (!phoneMatch || phoneMatch.index === undefined) return;

        const beforePhone = cleanText(line.slice(0, phoneMatch.index)).replace(/^\d+\s*/, '');
        const afterPhone = line.slice(phoneMatch.index + phoneMatch[0].length);
        const amountMatch = afterPhone.match(moneyPattern);
        if (!beforePhone || beforePhone.length < 2) return;

        rows.push({
            nome: beforePhone,
            telefone: phoneMatch[0],
            saldo_devedor: amountMatch ? amountMatch[0] : '',
            status: /devedor|atrasado|pendente|aberto|vencido/i.test(line) ? 'devedor' : '',
        });
    });

    return rows;
}

function rowsFromDebtPdf(lines) {
    const rows = [];
    const pending = [];
    const recordPattern = /^(.*?)(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*(devedor|em\s*dia|quitado|pendente|atrasado|vencido|aberto).*$/i;

    const flush = (line) => {
        const match = cleanText(line).match(recordPattern);
        if (!match) return false;
        const nome = cleanText(`${pending.join(' ')} ${match[1]}`)
            .replace(/\*?exclu[ií]do\*?/gi, '')
            .trim();
        pending.length = 0;
        if (!nome) return true;
        rows.push({ nome, saldo_devedor: match[2], status: match[3] });
        return true;
    };

    lines.forEach((line) => {
        const normalized = normalizeHeader(line);
        if (!line || /clientesaldo|saldositua|pag\.?\s*\d+|relatorio/.test(normalized)) return;
        if (flush([...pending, line].join(' '))) return;
        pending.push(line);
        if (pending.length > 3) pending.shift();
    });
    return rows;
}

function rowsFromProductPdf(lines) {
    const rows = [];
    const pattern = /^(\d{3,}?)(?=[A-Za-z])(.+?)(\d{1,3}(?:\.\d{3})*,\d{2})(\d{1,3}(?:\.\d{3})*,\d{2})([A-Za-z]{1,5})(-?\d+(?:,\d+)?)(.*)$/;
    lines.forEach((line) => {
        if (/produto|c[oó]d\.?\s*busca|pre[cç]o\s*custo/i.test(line)) return;
        const match = cleanText(line).match(pattern);
        if (!match) return;
        rows.push({
            codigo: match[1],
            nome: cleanText(match[2]),
            preco_custo: match[3],
            preco_venda: match[4],
            medida: match[5],
            estoque: match[6],
            observacao: cleanText(match[7]),
        });
    });
    return rows;
}

function inferListKind(filePath, rows = []) {
    const source = normalizeHeader(path.basename(String(filePath || '')));
    let sourceKind = null;
    if (/produto|estoque|catalogo/.test(source)) sourceKind = 'produtos';
    else if (/fiado|devedor|divida|cobranca|debito/.test(source)) sourceKind = 'devedores';
    else if (/cliente|contato/.test(source)) sourceKind = 'clientes';

    const headers = new Set(
        rows.slice(0, 10)
            .flatMap((row) => Object.keys(row || {}))
            .map(normalizeHeader)
            .filter((header) => header && !header.startsWith('__')),
    );
    if (!headers.size) return sourceKind;

    const hasHeader = (expression) => [...headers].some((header) => expression.test(header));
    const hasCustomerIdentity = hasHeader(/^(?:cliente|nomecliente|razaosocial|telefone.*|tel|fone.*|celular.*|whatsapp.*|contato.*|cpf.*|cnpj.*|documento.*|email.*|endereco.*|bairro|cep)$/);
    const hasDebt = hasHeader(/^(?:saldo(?:devedor|atual)?|valor(?:devido|divida)|devedor|divida|debito|limiteatingido|fiado)$/);
    const hasProductField = hasHeader(/^(?:produto|nomeproduto|descricaoproduto|categoria|estoque(?:atual|minimo)?|preco(?:venda|custo)?|custounitario|codigopdv|codigobarras|ean|unidade|medida)$/);
    const hasProductCode = hasHeader(/^(?:codigo|cod|idproduto|referencia|sku)$/);
    const hasProductValue = hasHeader(/^(?:venda|valorvenda|valorunitario|preco|precovenda|custo|precocusto)$/);
    const hasProductEvidence = hasProductField || (hasProductCode && hasProductValue);

    let rowKind = null;
    if (hasProductEvidence && (hasCustomerIdentity || hasDebt)) rowKind = null;
    else if (hasProductEvidence) rowKind = 'produtos';
    else if (hasDebt) rowKind = 'devedores';
    else if (hasCustomerIdentity) rowKind = 'clientes';

    if (sourceKind && rowKind && sourceKind !== rowKind) return null;
    return rowKind || sourceKind;
}

async function rowsFromPdf(filePath) {
    const parsed = await pdfParse(fs.readFileSync(filePath));
    const lines = String(parsed.text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (!lines.length) {
        throw new Error('O PDF nao possui texto selecionavel. Para PDF escaneado, exporte a tabela como XLSX ou CSV antes de importar.');
    }

    const kind = inferListKind(filePath);
    if (kind === 'devedores') {
        const debtRows = rowsFromDebtPdf(lines);
        if (debtRows.length) return debtRows;
    }
    if (kind === 'produtos') {
        const productRows = rowsFromProductPdf(lines);
        if (productRows.length) return productRows;
    }

    const rows = rowsFromHeaderTable(lines);
    if (rows.length) return rows;

    const inlineRows = rowsFromInlinePdfRecords(lines);
    if (inlineRows.length) return inlineRows;

    throw new Error('Nao foi possivel identificar uma tabela no PDF. Use um PDF textual com cabecalhos ou exporte-o como XLS, XLSX ou CSV.');
}

async function readImportRows(filePath) {
    const extension = assertSupportedFile(filePath);
    const rows = extension === '.pdf' ? await rowsFromPdf(filePath) : await readSpreadsheetRows(filePath);
    if (!rows.length) throw new Error('O arquivo nao contem linhas de dados para importar.');
    if (rows.length > MAX_ROWS) throw new Error('O arquivo possui mais de 100.000 linhas. Divida o arquivo antes de importar.');
    return { extension, rows, tipo: inferListKind(filePath, rows) };
}

function assertKnownListKind(kind) {
    if (kind) return kind;
    throw new Error(
        'Nao foi possivel identificar com seguranca se o arquivo contem clientes, devedores ou produtos. '
        + 'Use cabecalhos claros, como Telefone/CPF/Saldo para clientes ou Codigo/Produto/Preco/Venda/Estoque para produtos.',
    );
}

async function parseImportFile(filePath) {
    const { extension, rows, tipo } = await readImportRows(filePath);
    assertKnownListKind(tipo);
    if (tipo === 'produtos') {
        return {
            arquivo: path.basename(filePath),
            formato: extension.slice(1).toUpperCase(),
            tipo,
            rows,
            clientes: [],
            totalLido: rows.length,
            invalidos: 0,
        };
    }
    const normalized = rows
        .map((row) => normalizeCustomer(row, { source: path.basename(filePath), keepRaw: true }))
        .filter(Boolean);

    if (!normalized.length) {
        throw new Error('Nenhum cliente valido foi encontrado. Verifique as colunas de nome, telefone, CPF ou saldo.');
    }

    const unique = upsertCustomers([], normalized, { source: path.basename(filePath), keepRaw: true });
    return {
        arquivo: path.basename(filePath),
        formato: extension.slice(1).toUpperCase(),
        tipo,
        rows,
        clientes: unique.customers,
        totalLido: rows.length,
        invalidos: rows.length - normalized.length,
    };
}

module.exports = {
    SUPPORTED_EXTENSIONS: [...SUPPORTED_EXTENSIONS],
    parseImportFile,
    readImportRows,
    inferListKind,
    assertKnownListKind,
};
