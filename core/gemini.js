const fs = require('fs');
const path = require('path');
const { buildAnalytics, formatMoney } = require('./customer-utils');
const { buildProductAnalytics } = require('./product-utils');

const DEFAULT_MODEL = 'gemini-3.6-flash';
const API_KEY_NAMES = ['GEMINI_API_KEY', 'GEMINIKEY', 'GIMINAI', 'giminai', 'GOOGLE_API_KEY'];
const MODEL_PREFERENCES = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview'];
let discoveredModel = '';

function loadEnvFile() {
    const candidates = [
        process.env.VALEVERDE_ENV_PATH,
        process.env.VALEVERDE_DATA_DIR ? path.join(process.env.VALEVERDE_DATA_DIR, '.env') : '',
        path.join(__dirname, '..', '.env'),
    ].filter(Boolean);
    const envPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!envPath) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const index = trimmed.indexOf('=');
        if (index < 0) return;
        const key = trimmed.slice(0, index).trim();
        const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
        if (key && process.env[key] === undefined) process.env[key] = value;
    });
}

function getApiKey() {
    loadEnvFile();
    return API_KEY_NAMES.map((name) => process.env[name]).find(Boolean) || '';
}

function getStatus() {
    return {
        disponivel: Boolean(getApiKey()),
        modelo: process.env.GEMINI_MODEL || discoveredModel || DEFAULT_MODEL,
    };
}

async function resolveModel(apiKey) {
    if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
    if (discoveredModel) return discoveredModel;
    try {
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
            headers: { 'x-goog-api-key': apiKey },
        });
        if (!response.ok) return DEFAULT_MODEL;
        const payload = await response.json();
        const available = new Set((payload.models || [])
            .filter((model) => (model.supportedGenerationMethods || model.supported_actions || []).includes('generateContent'))
            .map((model) => String(model.name || '').replace(/^models\//, '')));
        discoveredModel = MODEL_PREFERENCES.find((model) => available.has(model)) || DEFAULT_MODEL;
    } catch {
        discoveredModel = DEFAULT_MODEL;
    }
    return discoveredModel;
}

function extractText(response) {
    return (response?.candidates || [])
        .flatMap((candidate) => candidate?.content?.parts || [])
        .map((part) => part.text || '')
        .join('\n')
        .trim();
}

async function generateContent(prompt, maxOutputTokens = 1200) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error('Chave Gemini nao encontrada. Configure GEMINI_API_KEY ou mantenha a chave giminai ja existente no .env.');
    }

    const model = await resolveModel(apiKey);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.25, maxOutputTokens },
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gemini retornou HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const text = extractText(await response.json());
    if (!text) throw new Error('Gemini nao retornou texto para esta solicitacao.');
    return text;
}

function campaignOutcome(reports = []) {
    const campaignReports = reports.filter((report) => Number.isFinite(Number(report.total)));
    const total = campaignReports.reduce((sum, report) => sum + Number(report.total || 0), 0);
    const sent = campaignReports.reduce((sum, report) => sum + Number(report.enviados || 0), 0);
    const errors = campaignReports.reduce((sum, report) => sum + Number(report.erros || 0), 0);
    return {
        campanhasRegistradas: campaignReports.length,
        destinatariosProcessados: total,
        enviados: sent,
        erros: errors,
        taxaErroPercentual: total ? Number(((errors / total) * 100).toFixed(2)) : 0,
    };
}

function compactContext(customers = [], products = [], imports = [], reports = []) {
    const analytics = buildAnalytics(customers);
    const productAnalytics = buildProductAnalytics(products);
    const recentImports = imports.slice(0, 20).map((item) => ({
        arquivo: item.arquivo,
        tipo: item.tipo,
        formato: item.formato,
        status: item.status,
        totalLido: item.totalLido,
        created: item.created,
        updated: item.updated,
        ignored: item.ignored,
        erro: item.erro || '',
    }));
    return {
        loja: {
            ...analytics.store,
            totalDebtFormatted: formatMoney(analytics.store.totalDebt),
            averageDebtFormatted: formatMoney(analytics.store.averageDebt),
            delinquencyRatePercent: Number((analytics.store.delinquencyRate * 100).toFixed(2)),
        },
        estoque: productAnalytics,
        campanhas: campaignOutcome(reports),
        maioresDevedores: analytics.debtors.slice(0, 40).map(({ nome, saldo_devedor, status, ultimaCompra, perfilAnalitico }) => ({ nome, saldo_devedor, status, ultimaCompra, perfilAnalitico })),
        amostraClientes: analytics.customers.slice(0, 80).map(({ nome, saldo_devedor, status, perfilAnalitico }) => ({ nome, saldo_devedor, status, perfilAnalitico })),
        importacoesRecentes: recentImports,
    };
}

function localDiagnostics(customers = [], products = [], imports = [], reports = []) {
    const analytics = buildAnalytics(customers);
    const productAnalytics = buildProductAnalytics(products);
    const importFailures = imports.filter((item) => item.status === 'erro').slice(0, 10);
    const missingPhones = analytics.customers.filter((customer) => !customer.telefone).length;
    const campaigns = campaignOutcome(reports);
    return {
        clientesSemTelefone: missingPhones,
        devedoresAbaixoLimiteDeCobranca: analytics.debtors.filter((customer) => customer.saldo_devedor > 0 && customer.saldo_devedor < 50).length,
        baixoEstoque: productAnalytics.baixoEstoque,
        produtosSemCodigo: productAnalytics.semCodigo,
        vendasAbaixoDoCusto: productAnalytics.vendaAbaixoCusto,
        falhasDeImportacao: importFailures.map((item) => ({ arquivo: item.arquivo, erro: item.erro })),
        taxaErroDeCampanhas: campaigns.taxaErroPercentual,
    };
}

function requireBusinessData(customers, products) {
    if (!Array.isArray(customers) || !Array.isArray(products) || (!customers.length && !products.length)) {
        throw new Error('Nao ha clientes ou produtos persistidos para a analise.');
    }
}

async function generateExecutiveReport(customers, products = [], imports = [], reports = []) {
    requireBusinessData(customers, products);
    const context = compactContext(customers, products, imports, reports);
    const prompt = [
        'Voce e um analista financeiro e operacional senior de varejo alimentar.',
        'Gere um relatorio executivo curto, objetivo e acionavel em portugues do Brasil.',
        'Use apenas os dados fornecidos. Nao invente clientes, historicos, percentuais, estoque, produtos ou datas.',
        'Cubra saude financeira, inadimplencia, riscos de estoque, qualidade da base, desempenho de campanhas e 3 proximas acoes priorizadas.',
        'Dados JSON:',
        JSON.stringify(context),
    ].join('\n');
    return generateContent(prompt);
}

async function answerQuestion(customers, products, imports, reports, question, previousReport = '') {
    requireBusinessData(customers, products);
    if (!String(question || '').trim()) throw new Error('Informe uma pergunta para a Gemini AI.');
    const context = compactContext(customers, products, imports, reports);
    const prompt = [
        'Voce responde como analista de negocio da loja, em portugues do Brasil.',
        'Responda somente com base no JSON e no relatorio anterior, quando existir.',
        'Se a pergunta pedir dado inexistente, diga objetivamente que a base atual nao possui essa coluna.',
        previousReport ? `Relatorio anterior:\n${previousReport}` : '',
        `Pergunta do gestor: ${question}`,
        'Dados JSON:',
        JSON.stringify(context),
    ].filter(Boolean).join('\n\n');
    return generateContent(prompt);
}

async function diagnoseOperations(customers, products, imports, reports) {
    requireBusinessData(customers, products);
    const context = compactContext(customers, products, imports, reports);
    const diagnostics = localDiagnostics(customers, products, imports, reports);
    const prompt = [
        'Voce e responsavel por diagnosticar a operacao de uma loja de alimentos.',
        'Produza um diagnostico pratico em portugues do Brasil, priorizado por Critico, Atencao e Oportunidade.',
        'Para cada ponto, informe impacto, causa provavel baseada nos dados e a acao concreta que o gestor deve executar.',
        'Nao invente falhas, politicas, descontos ou resultados. Trate falhas de importacao como alertas tecnicos e recomende uma correcao segura.',
        'Sinais calculados localmente:',
        JSON.stringify(diagnostics),
        'Contexto consolidado:',
        JSON.stringify(context),
    ].join('\n');
    return generateContent(prompt);
}

async function suggestCampaignMessage(customers, products, input = {}) {
    requireBusinessData(customers, products);
    const tipo = input.tipo === 'cobranca' ? 'cobranca' : 'promocao';
    const context = compactContext(customers, products, [], []);
    const prompt = [
        'Escreva uma unica mensagem curta de WhatsApp em portugues do Brasil para uma loja de alimentos.',
        `Tipo da campanha: ${tipo}.`,
        tipo === 'cobranca'
            ? 'Use tom cordial, profissional e nao ameacador. Inclua apenas os placeholders {{nome}} e {{saldo_devedor}} quando fizer sentido.'
            : 'Nao invente desconto, produto, prazo ou condicao comercial. Faca uma mensagem geral que o gestor possa revisar antes do envio.',
        'Nao use emojis, nao inclua explicacoes, titulo ou observacoes fora da mensagem.',
        'Use os dados somente para orientar o tom e a prioridade:',
        JSON.stringify({ loja: context.loja, estoque: context.estoque }),
        input.mensagemAtual ? `Rascunho atual a melhorar: ${String(input.mensagemAtual).slice(0, 1200)}` : '',
    ].filter(Boolean).join('\n');
    return generateContent(prompt, 500);
}

module.exports = {
    getStatus,
    generateExecutiveReport,
    answerQuestion,
    diagnoseOperations,
    suggestCampaignMessage,
};
