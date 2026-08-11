const crypto = require('crypto');
const { SignatureCache, createSignature } = require('./ai-cache');
const { buildAnalytics, formatMoney, getDebtAmount } = require('./customer-utils');
const { buildProductAnalytics, isLowStock } = require('./product-utils');
const { campaignSummary } = require('./ai-actions');

const STOP_WORDS = new Set([
    'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'essa', 'esse',
    'esta', 'este', 'eu', 'me', 'meu', 'minha', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'por',
    'qual', 'que', 'se', 'sem', 'sobre', 'um', 'uma', 'voce', 'loja', 'dados', 'base', 'atual', 'favor',
]);

function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function trimText(value, maximum = 240) {
    return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function finite(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function hasNumericValue(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function termsFromQuestion(question) {
    return [...new Set(normalize(question).split(/\s+/).filter((term) => term.length >= 3 && !STOP_WORDS.has(term)))].slice(0, 16);
}

function classifyIntent(question = '', operation = 'question') {
    const text = normalize(question);
    const all = operation === 'executive-report' || operation === 'diagnostics' || !text;
    const intent = {
        all,
        customers: all || /client|pessoa|nome|telefone|cadastro/.test(text),
        finance: all || /divid|divida|deved|inadimpl|saldo|finance|receb|cobr|valor/.test(text),
        products: all || /produt|estoque|preco|custo|venda|categoria|sku|codigo|mercadoria/.test(text),
        campaigns: all || /campanh|envio|whatsapp|mensagem|disparo|sucesso|erro/.test(text),
        imports: all || /import|planilh|arquivo|sincron|qualidade|coluna|csv|xlsx|pdf/.test(text),
        operational: /envi|mand|dispar|agend|program|prepar|notific|lembret/.test(text),
    };
    if (!Object.values(intent).some(Boolean)) intent.all = true;
    if (intent.finance) intent.customers = true;
    return intent;
}

function hashRecord(hash, prefix, record, fields) {
    hash.update(`${prefix}\u001f`);
    fields.forEach((field) => hash.update(`${trimText(record?.[field], 1000)}\u001e`));
}

function createBusinessSignature(datasets = {}) {
    const customers = Array.isArray(datasets.customers) ? datasets.customers : [];
    const products = Array.isArray(datasets.products) ? datasets.products : [];
    const imports = Array.isArray(datasets.imports) ? datasets.imports : [];
    const reports = Array.isArray(datasets.reports) ? datasets.reports : [];
    const spreadsheets = Array.isArray(datasets.spreadsheets) ? datasets.spreadsheets : [];
    const runtime = datasets.runtime && typeof datasets.runtime === 'object' ? datasets.runtime : {};
    const hash = crypto.createHash('sha256');
    hash.update(`v3|${customers.length}|${products.length}|${imports.length}|${reports.length}|${spreadsheets.length}|`);
    customers.forEach((record) => hashRecord(hash, 'c', record, ['id', 'nome', 'telefone', 'saldo_devedor', 'valorDevido', 'status', 'ultimaCompra', 'atualizadoEm']));
    products.forEach((record) => hashRecord(hash, 'p', record, ['id', 'codigo', 'nome', 'categoria', 'precoCusto', 'precoVenda', 'estoque', 'estoqueMinimo', 'situacaoEstoque', 'atualizadoEm']));
    imports.forEach((record) => hashRecord(hash, 'i', record, ['id', 'data', 'arquivo', 'assinatura', 'status', 'totalLido', 'created', 'updated', 'ignored', 'erro']));
    reports.forEach((record) => hashRecord(hash, 'r', record, ['id', 'data', 'tipo', 'total', 'enviados', 'erros', 'ignorados', 'mensagem']));
    spreadsheets.forEach((source) => {
        hashRecord(hash, 's', source, ['name', 'signature', 'updatedAt']);
        (Array.isArray(source.rows) ? source.rows : []).forEach((row) => hash.update(`${createSignature(row)}\u001d`));
    });
    hash.update(`runtime\u001f${createSignature(runtimeSummary(runtime))}`);
    return hash.digest('hex');
}

function runtimeSummary(runtime = {}) {
    const whatsapp = runtime.whatsapp && typeof runtime.whatsapp === 'object' ? runtime.whatsapp : {};
    const campaign = runtime.campaign && typeof runtime.campaign === 'object' ? runtime.campaign : {};
    const whatsappStatus = trimText(whatsapp.status || 'desconectado', 40).toLowerCase();
    return {
        whatsapp: {
            status: whatsappStatus,
            conectado: whatsappStatus === 'conectado',
            possuiNumeroVinculado: Boolean(whatsapp.numero),
            possuiErro: Boolean(whatsapp.erro),
        },
        campanha: {
            ativa: Boolean(campaign.active),
            pausada: Boolean(campaign.paused),
            cancelamentoSolicitado: Boolean(campaign.cancelRequested),
        },
        capacidades: {
            consultasLocais: true,
            rascunhosOperacionais: true,
            envioExigeTesteEConfirmacaoHumana: true,
            agendadorAutomaticoDisponivel: false,
        },
    };
}

function debtBuckets(customers) {
    const buckets = [
        { faixa: 'ate_49_99', min: 0.01, max: 49.99, quantidade: 0, total: 0 },
        { faixa: '50_a_199_99', min: 50, max: 199.99, quantidade: 0, total: 0 },
        { faixa: '200_a_499_99', min: 200, max: 499.99, quantidade: 0, total: 0 },
        { faixa: '500_a_999_99', min: 500, max: 999.99, quantidade: 0, total: 0 },
        { faixa: '1000_ou_mais', min: 1000, max: Number.POSITIVE_INFINITY, quantidade: 0, total: 0 },
    ];
    customers.forEach((customer) => {
        const debt = finite(getDebtAmount(customer));
        const bucket = buckets.find((item) => debt >= item.min && debt <= item.max);
        if (!bucket) return;
        bucket.quantidade += 1;
        bucket.total += debt;
    });
    return buckets.map(({ min, max, ...bucket }) => ({ ...bucket, total: Number(bucket.total.toFixed(2)) }));
}

function statusDistribution(records, field = 'status') {
    const distribution = new Map();
    records.forEach((record) => {
        const status = trimText(record?.[field] || 'nao_informado', 80);
        distribution.set(status, (distribution.get(status) || 0) + 1);
    });
    return [...distribution.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 20)
        .map(([status, quantidade]) => ({ status, quantidade }));
}

function customerSummary(customers) {
    const analytics = buildAnalytics(customers);
    const store = analytics.store;
    return {
        totalClientes: store.totalCustomers,
        clientesComTelefone: store.customersWithPhone,
        clientesSemTelefone: Math.max(0, store.totalCustomers - store.customersWithPhone),
        devedores: store.debtors,
        devedoresElegiveisAcimaDe50: store.debtorsAboveThreshold,
        dividaTotal: Number(store.totalDebt.toFixed(2)),
        dividaTotalFormatada: formatMoney(store.totalDebt),
        dividaMedia: Number(store.averageDebt.toFixed(2)),
        dividaMediaFormatada: formatMoney(store.averageDebt),
        taxaInadimplenciaPercentual: Number((store.delinquencyRate * 100).toFixed(2)),
        faixasDeDivida: debtBuckets(customers),
        distribuicaoStatus: statusDistribution(customers),
    };
}

function productSummary(products) {
    const analytics = buildProductAnalytics(products);
    const categories = new Map();
    let knownStock = 0;
    let zeroStock = 0;
    let inventoryAtCost = 0;
    let inventoryAtSale = 0;
    let knownMargins = 0;
    let marginSum = 0;
    products.forEach((product) => {
        const category = trimText(product.categoria || 'Sem categoria', 100);
        categories.set(category, (categories.get(category) || 0) + 1);
        const stock = hasNumericValue(product.estoque) ? Number(product.estoque) : Number.NaN;
        const cost = finite(product.precoCusto);
        const sale = finite(product.precoVenda);
        if (Number.isFinite(stock)) {
            knownStock += 1;
            if (stock <= 0) zeroStock += 1;
            if (stock > 0) {
                inventoryAtCost += stock * cost;
                inventoryAtSale += stock * sale;
            }
        }
        if (cost > 0 && sale > 0) {
            knownMargins += 1;
            marginSum += ((sale - cost) / sale) * 100;
        }
    });
    return {
        ...analytics,
        produtosComEstoqueInformado: knownStock,
        produtosSemEstoqueInformado: Math.max(0, products.length - knownStock),
        produtosComEstoqueZeradoOuNegativo: zeroStock,
        valorEstoqueACusto: Number(inventoryAtCost.toFixed(2)),
        valorEstoqueAPrecoDeVenda: Number(inventoryAtSale.toFixed(2)),
        margemMediaPercentual: knownMargins ? Number((marginSum / knownMargins).toFixed(2)) : null,
        categoriasPrincipais: [...categories.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, 20)
            .map(([categoria, quantidade]) => ({ categoria, quantidade })),
    };
}

function importsSummary(imports) {
    const completed = imports.filter((item) => item.status === 'concluida');
    const failed = imports.filter((item) => item.status === 'erro');
    return {
        totalRegistros: imports.length,
        concluidas: completed.length,
        comErro: failed.length,
        totalLinhasLidas: imports.reduce((sum, item) => sum + finite(item.totalLido), 0),
        criados: imports.reduce((sum, item) => sum + finite(item.created), 0),
        atualizados: imports.reduce((sum, item) => sum + finite(item.updated), 0),
        ignorados: imports.reduce((sum, item) => sum + finite(item.ignored), 0),
        ultimaImportacao: imports.map((item) => item.data).filter(Boolean).sort().at(-1) || null,
    };
}

function scoreText(haystack, terms) {
    if (!terms.length) return 0;
    const normalized = normalize(haystack);
    return terms.reduce((score, term) => score + (normalized.includes(term) ? Math.min(5, term.length / 2) : 0), 0);
}

function uniqueRecords(records, identity = (record) => record.id || JSON.stringify(record)) {
    const seen = new Set();
    return records.filter((record) => {
        const key = String(identity(record));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function safeCustomer(customer) {
    return {
        id: trimText(customer.id, 120),
        nome: trimText(customer.nome, 180),
        saldoDevedor: Number(finite(getDebtAmount(customer)).toFixed(2)),
        status: trimText(customer.status, 100),
        ultimaCompra: trimText(customer.ultimaCompra, 100),
        possuiTelefone: Boolean(customer.telefone || customer.telefoneValido || customer.telefoneOriginal),
        perfilAnalitico: customer.perfilAnalitico ? {
            nivel: trimText(customer.perfilAnalitico.nivel, 60),
            rotulo: trimText(customer.perfilAnalitico.rotulo, 120),
            elegivelCobranca: Boolean(customer.perfilAnalitico.elegivelCobranca),
        } : undefined,
    };
}

function safeProduct(product) {
    const cost = finite(product.precoCusto);
    const sale = finite(product.precoVenda);
    return {
        id: trimText(product.id, 140),
        codigo: trimText(product.codigo, 80),
        nome: trimText(product.nome, 200),
        categoria: trimText(product.categoria, 120),
        estoque: hasNumericValue(product.estoque) ? Number(product.estoque) : null,
        estoqueMinimo: hasNumericValue(product.estoqueMinimo) ? Number(product.estoqueMinimo) : null,
        precoCusto: Number(cost.toFixed(2)),
        precoVenda: Number(sale.toFixed(2)),
        margemPercentual: cost > 0 && sale > 0 ? Number((((sale - cost) / sale) * 100).toFixed(2)) : null,
        baixoEstoque: isLowStock(product),
        situacaoEstoque: trimText(product.situacaoEstoque, 100),
        statusVenda: trimText(product.statusVenda, 100),
    };
}

function safeReport(report) {
    return {
        id: trimText(report.id, 140),
        data: trimText(report.data, 80),
        tipo: trimText(report.tipo, 80),
        total: Number.isFinite(Number(report.total)) ? Number(report.total) : null,
        enviados: Number.isFinite(Number(report.enviados)) ? Number(report.enviados) : null,
        erros: Number.isFinite(Number(report.erros)) ? Number(report.erros) : null,
        ignorados: Number.isFinite(Number(report.ignorados)) ? Number(report.ignorados) : null,
        arquivos: (Array.isArray(report.arquivos) ? report.arquivos : [report.arquivo]).filter(Boolean).map((file) => trimText(file, 160)).slice(0, 5),
    };
}

function safeImport(item) {
    return {
        id: trimText(item.id, 140),
        data: trimText(item.data, 80),
        arquivo: trimText(item.arquivo, 180),
        tipo: trimText(item.tipo, 80),
        formato: trimText(item.formato, 30),
        status: trimText(item.status, 60),
        totalLido: finite(item.totalLido),
        created: finite(item.created),
        updated: finite(item.updated),
        ignored: finite(item.ignored),
        erro: trimText(item.erro, 400),
    };
}

function safeSpreadsheetCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    return trimText(value, 300);
}

function safeSpreadsheetRow(row) {
    return Object.fromEntries(Object.entries(row || {}).slice(0, 30).map(([key, value]) => {
        const safeKey = trimText(key, 80);
        const normalizedKey = normalize(safeKey).replace(/\s+/g, '');
        if (/(senha|password|secret|token|apikey|chaveapi|credencial)/.test(normalizedKey)) {
            return [safeKey, '[segredo omitido]'];
        }
        if (/(cpf|cnpj|documento|telefone|celular|whatsapp|email|endereco|cep)/.test(normalizedKey)) {
            return [safeKey, '[dado pessoal omitido]'];
        }
        return [safeKey, safeSpreadsheetCell(value)];
    }));
}

function selectDetails(datasets, terms, intent) {
    const customers = datasets.customers || [];
    const products = datasets.products || [];
    const reports = datasets.reports || [];
    const imports = datasets.imports || [];
    const spreadsheets = datasets.spreadsheets || [];

    const customerMatches = customers
        .map((record) => ({ record, score: scoreText(`${record.nome} ${record.status} ${record.ultimaCompra}`, terms) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((item) => item.record);
    const topDebtors = [...customers].filter((record) => getDebtAmount(record) > 0).sort((left, right) => getDebtAmount(right) - getDebtAmount(left));
    const selectedCustomers = uniqueRecords([
        ...customerMatches,
        ...(intent.finance ? topDebtors : []),
        ...(intent.customers || intent.all ? customers : []),
    ]).slice(0, intent.finance ? 140 : 80).map(safeCustomer);

    const productMatches = products
        .map((record) => ({ record, score: scoreText(`${record.codigo} ${record.nome} ${record.categoria} ${record.situacaoEstoque}`, terms) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((item) => item.record);
    const riskyProducts = products.filter((record) => isLowStock(record) || (finite(record.precoCusto) > finite(record.precoVenda) && finite(record.precoVenda) > 0));
    const selectedProducts = uniqueRecords([
        ...productMatches,
        ...(intent.products || intent.all ? riskyProducts : []),
        ...(intent.all ? products : []),
    ]).slice(0, intent.products ? 160 : 80).map(safeProduct);

    const selectedReports = (intent.campaigns || intent.all ? reports : []).slice(0, 80).map(safeReport);
    const selectedImports = (intent.imports || intent.all ? imports : imports.filter((item) => item.status === 'erro')).slice(0, 80).map(safeImport);
    const selectedSpreadsheetRows = [];
    if (intent.imports || intent.all || terms.length) {
        spreadsheets.forEach((source) => {
            const rows = Array.isArray(source.rows) ? source.rows : [];
            let matches = rows
                .map((row) => ({ row, score: scoreText(JSON.stringify(row), terms) }))
                .filter((item) => !terms.length || item.score > 0)
                .sort((left, right) => right.score - left.score)
                .slice(0, 30)
                .map((item) => safeSpreadsheetRow(item.row));
            if (!matches.length && (intent.imports || intent.all)) {
                matches = rows.slice(0, 30).map(safeSpreadsheetRow);
            }
            if (matches.length) selectedSpreadsheetRows.push({ fonte: trimText(source.name, 180), linhas: matches });
        });
    }
    return {
        clientes: selectedCustomers,
        produtos: selectedProducts,
        campanhas: selectedReports,
        importacoes: selectedImports,
        planilhasAdicionais: selectedSpreadsheetRows,
    };
}

function enforceBudget(context, budgetChars) {
    const arrays = [
        context.detalhes.clientes,
        context.detalhes.produtos,
        context.detalhes.campanhas,
        context.detalhes.importacoes,
    ];
    const spreadsheetSources = context.detalhes.planilhasAdicionais;
    const serializedLength = () => JSON.stringify(context).length;
    while (serializedLength() > budgetChars) {
        const spreadsheetWithRows = spreadsheetSources.filter((source) => source.linhas.length).sort((left, right) => right.linhas.length - left.linhas.length)[0];
        const largest = arrays.filter((array) => array.length).sort((left, right) => right.length - left.length)[0];
        if (!largest && !spreadsheetWithRows) break;
        if (spreadsheetWithRows && (!largest || spreadsheetWithRows.linhas.length >= largest.length)) spreadsheetWithRows.linhas.pop();
        else largest.pop();
    }
    context.detalhes.planilhasAdicionais = spreadsheetSources.filter((source) => source.linhas.length);
    context.cobertura.incluidos = {
        clientes: context.detalhes.clientes.length,
        produtos: context.detalhes.produtos.length,
        campanhas: context.detalhes.campanhas.length,
        importacoes: context.detalhes.importacoes.length,
        linhasPlanilhasAdicionais: context.detalhes.planilhasAdicionais.reduce((sum, source) => sum + source.linhas.length, 0),
    };
    context.cobertura.truncadoPorOrcamento = serializedLength() > budgetChars
        || context.cobertura.incluidos.clientes < context.cobertura.avaliados.clientes
        || context.cobertura.incluidos.produtos < context.cobertura.avaliados.produtos;
    return context;
}

function buildContextValue(datasets, options) {
    const customers = Array.isArray(datasets.customers) ? datasets.customers : [];
    const products = Array.isArray(datasets.products) ? datasets.products : [];
    const imports = Array.isArray(datasets.imports) ? datasets.imports : [];
    const reports = Array.isArray(datasets.reports) ? datasets.reports : [];
    const spreadsheets = Array.isArray(datasets.spreadsheets) ? datasets.spreadsheets : [];
    const runtime = datasets.runtime && typeof datasets.runtime === 'object' ? datasets.runtime : {};
    const question = String(options.question || '');
    const intent = classifyIntent(question, options.operation);
    const terms = termsFromQuestion(question);
    const details = selectDetails({ customers, products, imports, reports, spreadsheets }, terms, intent);
    const spreadsheetRows = spreadsheets.reduce((sum, source) => sum + (Array.isArray(source.rows) ? source.rows.length : 0), 0);
    const context = {
        versaoContexto: 3,
        geradoEm: new Date().toISOString(),
        consulta: { operacao: options.operation, intencoes: intent, termosDeRecuperacao: terms },
        cobertura: {
            estrategia: 'Todos os registros foram avaliados localmente; apenas os itens mais relevantes cabem no prompt.',
            avaliados: { clientes: customers.length, produtos: products.length, campanhas: reports.length, importacoes: imports.length, linhasPlanilhasAdicionais: spreadsheetRows },
            incluidos: {},
            truncadoPorOrcamento: false,
        },
        resumoFinanceiro: customerSummary(customers),
        resumoEstoque: productSummary(products),
        resumoCampanhas: campaignSummary(reports),
        resumoImportacoes: importsSummary(imports),
        integracoes: runtimeSummary(runtime),
        qualidadeDados: {
            clientesSemTelefone: customers.filter((record) => !(record.telefone || record.telefoneValido || record.telefoneOriginal)).length,
            produtosSemCodigo: products.filter((record) => !trimText(record.codigo)).length,
            produtosSemEstoqueInformado: products.filter((record) => !hasNumericValue(record.estoque)).length,
            importacoesComErro: imports.filter((record) => record.status === 'erro').length,
        },
        detalhes: details,
    };
    return { context: enforceBudget(context, options.budgetChars), intent, terms };
}

class BusinessContextService {
    constructor(options = {}) {
        this.cache = options.cache || new SignatureCache({
            ttlMs: options.ttlMs ?? 5 * 60 * 1000,
            maxEntries: options.maxEntries ?? 40,
            now: options.now,
        });
    }

    build(datasets = {}, options = {}) {
        const normalizedDatasets = {
            customers: Array.isArray(datasets.customers) ? datasets.customers : [],
            products: Array.isArray(datasets.products) ? datasets.products : [],
            imports: Array.isArray(datasets.imports) ? datasets.imports : [],
            reports: Array.isArray(datasets.reports) ? datasets.reports : [],
            spreadsheets: Array.isArray(datasets.spreadsheets) ? datasets.spreadsheets : [],
            runtime: datasets.runtime && typeof datasets.runtime === 'object' ? datasets.runtime : {},
        };
        const budgetChars = Math.min(100000, Math.max(6000, finite(options.budgetChars, 36000)));
        const signature = createBusinessSignature(normalizedDatasets);
        const cacheKey = createSignature({
            operation: options.operation || 'question',
            question: normalize(options.question),
            budgetChars,
        });
        const cached = this.cache.getOrCreate(cacheKey, signature, () => buildContextValue(normalizedDatasets, {
            operation: options.operation || 'question',
            question: options.question || '',
            budgetChars,
        }));
        return {
            ...cached.value,
            json: JSON.stringify(cached.value.context),
            signature,
            cached: cached.cached,
            budgetChars,
        };
    }

    clear() {
        this.cache.clear();
    }

    stats() {
        return this.cache.stats();
    }
}

module.exports = {
    BusinessContextService,
    createBusinessSignature,
    classifyIntent,
    termsFromQuestion,
};
