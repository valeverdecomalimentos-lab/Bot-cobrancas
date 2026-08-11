const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    GeminiRestClient,
    GeminiIncompleteResponseError,
    fetchJsonWithRetry,
} = require('../core/ai-client');
const { SignatureCache } = require('../core/ai-cache');
const { ConversationHistory } = require('../core/ai-history');
const { BusinessContextService } = require('../core/ai-context');
const { prepareOperationalAction, runReadOnlyTool } = require('../core/ai-actions');

function response(payload, status = 200, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers[String(name).toLowerCase()] || '' },
        text: async () => JSON.stringify(payload),
    };
}

function geminiPayload(text, finishReason = 'STOP') {
    return {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
        usageMetadata: { totalTokenCount: 10 },
    };
}

test('GeminiRestClient continua MAX_TOKENS e remove sobreposicao', async () => {
    const requests = [];
    const payloads = [
        geminiPayload('Primeira parte com trecho compartilhado', 'MAX_TOKENS'),
        geminiPayload('trecho compartilhado e conclusao.', 'STOP'),
    ];
    const client = new GeminiRestClient({
        fetchImpl: async (_url, request) => {
            requests.push(JSON.parse(request.body));
            return response(payloads.shift());
        },
        maxRetries: 0,
    });

    const result = await client.generate({
        apiKey: 'test-key',
        model: 'test-model',
        prompt: 'Analise.',
        systemInstruction: 'Regra do sistema.',
        maxOutputTokens: 256,
    });

    assert.equal(result.text, 'Primeira parte com trecho compartilhado e conclusao.');
    assert.equal(result.complete, true);
    assert.equal(result.continuationCount, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].contents.length, 3);
    assert.equal(requests[1].contents[1].role, 'model');
    assert.match(requests[1].contents[2].parts[0].text, /Continue exatamente/);
    assert.equal(requests[0].systemInstruction.parts[0].text, 'Regra do sistema.');
});

test('GeminiRestClient repete somente falhas transitorias e informa tentativas', async () => {
    let calls = 0;
    const delays = [];
    const client = new GeminiRestClient({
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return response({ error: { message: 'busy' } }, 429, { 'retry-after': '0' });
            return response(geminiPayload('Resposta completa.'));
        },
        sleep: async (milliseconds) => delays.push(milliseconds),
        random: () => 0,
        maxRetries: 2,
    });

    const result = await client.generate({ apiKey: 'test-key', model: 'test-model', prompt: 'Pergunta' });
    assert.equal(result.text, 'Resposta completa.');
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
    assert.equal(delays.length, 1);
});

test('GeminiRestClient nunca devolve corte como resposta completa', async () => {
    const client = new GeminiRestClient({
        fetchImpl: async () => response(geminiPayload('Texto ainda incompleto', 'MAX_TOKENS')),
        maxRetries: 0,
        maxContinuations: 0,
    });

    await assert.rejects(
        client.generate({ apiKey: 'test-key', model: 'test-model', prompt: 'Pergunta', maxContinuations: 0 }),
        (error) => error instanceof GeminiIncompleteResponseError
            && error.code === 'GEMINI_INCOMPLETE_RESPONSE'
            && error.partialText === 'Texto ainda incompleto'
    );
});

test('cliente HTTP cancela requisicao que excede o timeout', async () => {
    const hangingFetch = async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
        }, { once: true });
    });
    await assert.rejects(
        fetchJsonWithRetry('https://example.invalid', {}, { fetchImpl: hangingFetch, timeoutMs: 25, maxRetries: 0 }),
        (error) => error.code === 'GEMINI_TIMEOUT' && error.retryable === true
    );
});

test('erro do Gemini preserva o motivo remoto sem revelar a chave', async () => {
    const fakeKey = 'AQ.AuthorizationKeySomenteParaTeste123456789';
    await assert.rejects(
        fetchJsonWithRetry('https://example.invalid', {}, {
            fetchImpl: async () => response({
                error: { message: `Credencial sem permissao: ${fakeKey}` },
            }, 403),
            maxRetries: 0,
        }),
        (error) => error.code === 'GEMINI_HTTP_ERROR'
            && error.status === 403
            && /Credencial sem permissao/.test(error.message)
            && /\[chave omitida\]/.test(error.message)
            && !error.message.includes(fakeKey),
    );
});

test('SignatureCache respeita assinatura, TTL e invalidacao', () => {
    let now = 1000;
    const cache = new SignatureCache({ ttlMs: 100, now: () => now });
    cache.set('contexto', 'assinatura-a', { total: 1 });
    assert.deepEqual(cache.get('contexto', 'assinatura-a'), { total: 1 });
    assert.equal(cache.get('contexto', 'assinatura-b'), undefined);
    cache.set('contexto', 'assinatura-b', { total: 2 });
    now = 1101;
    assert.equal(cache.get('contexto', 'assinatura-b'), undefined);
});

test('BusinessContextService recupera registros pela pergunta e invalida com dados novos', () => {
    const service = new BusinessContextService({ ttlMs: 10000 });
    const datasets = {
        customers: [
            { id: 'ana', nome: 'Ana Lima', telefone: '22999999999', saldo_devedor: 450, status: 'Devedor' },
            { id: 'bia', nome: 'Beatriz Melo', telefone: '', saldo_devedor: 0, status: 'Em dia' },
        ],
        products: [
            { id: 'arroz', codigo: '10', nome: 'Arroz Integral', categoria: 'Graos', estoque: 2, estoqueMinimo: 5, precoCusto: 8, precoVenda: 12 },
            { id: 'suco', codigo: '20', nome: 'Suco de Uva', categoria: 'Bebidas', estoque: 30, estoqueMinimo: 3, precoCusto: 5, precoVenda: 9 },
        ],
        imports: [],
        reports: [],
        runtime: { whatsapp: { status: 'desconectado' }, campaign: { active: false } },
    };

    const first = service.build(datasets, { operation: 'question', question: 'Como esta o estoque do arroz?', budgetChars: 10000 });
    const second = service.build(datasets, { operation: 'question', question: 'Como esta o estoque do arroz?', budgetChars: 10000 });
    assert.equal(first.context.detalhes.produtos[0].nome, 'Arroz Integral');
    assert.equal(first.context.integracoes.whatsapp.conectado, false);
    assert.equal(first.context.integracoes.capacidades.envioExigeTesteEConfirmacaoHumana, true);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);

    const changed = service.build({
        ...datasets,
        products: datasets.products.map((product) => product.id === 'arroz' ? { ...product, estoque: 20 } : product),
    }, { operation: 'question', question: 'Como esta o estoque do arroz?', budgetChars: 10000 });
    assert.equal(changed.cached, false);
    assert.notEqual(changed.signature, first.signature);
});

test('contexto de planilhas omite contatos, documentos e segredos antes do prompt', () => {
    const service = new BusinessContextService();
    const bundle = service.build({
        spreadsheets: [{
            name: 'operacao.xlsx',
            rows: [{ Nome: 'Ana', Email: 'ana@example.com', CPF: '12345678900', API_TOKEN: 'token-ultrassecreto-123', Observacao: 'Cliente recorrente' }],
        }],
    }, { operation: 'executive-report', question: '', budgetChars: 10000 });

    const [row] = bundle.context.detalhes.planilhasAdicionais[0].linhas;
    assert.equal(row.Nome, 'Ana');
    assert.equal(row.Email, '[dado pessoal omitido]');
    assert.equal(row.CPF, '[dado pessoal omitido]');
    assert.equal(row.API_TOKEN, '[segredo omitido]');
    assert.equal(row.Observacao, 'Cliente recorrente');
    assert.doesNotMatch(bundle.json, /ana@example\.com|12345678900|token-ultrassecreto-123/);
});

test('ConversationHistory persiste, limita e prepara historico para prompt', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-ai-test-'));
    const filePath = path.join(directory, 'history.json');
    try {
        const first = new ConversationHistory({ filePath, maxMessages: 4 });
        first.appendExchange('gestor', 'Qual o saldo?', 'O saldo total e R$ 100,00.');
        first.appendExchange('gestor', 'E os clientes?', 'Ha dois clientes.');
        first.appendExchange('gestor', 'Mais uma?', 'Resposta final.');

        const loaded = new ConversationHistory({ filePath, maxMessages: 4 });
        const messages = loaded.get('gestor');
        assert.equal(messages.length, 4);
        assert.equal(messages.at(-1).text, 'Resposta final.');
        assert.ok(loaded.forPrompt('gestor', { maxChars: 500 }).length > 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ferramentas operacionais apenas leem ou preparam rascunhos', () => {
    const datasets = {
        customers: [
            { id: '1', nome: 'Ana', telefone: '22999999999', saldo_devedor: 120, status: 'Devedor' },
            { id: '2', nome: 'Bia', telefone: '22999999998', saldo_devedor: 20, status: 'Devedor' },
        ],
        products: [], imports: [], reports: [],
        runtime: { whatsapp: { status: 'conectado' } },
    };
    const found = runReadOnlyTool('buscar_clientes', datasets, { minimumDebt: 100 });
    const draft = prepareOperationalAction('preparar_cobranca', datasets, { minimumDebt: 50 });
    assert.equal(found.totalEncontrado, 1);
    assert.equal(draft.executable, false);
    assert.equal(draft.requiresHumanApproval, true);
    assert.deepEqual(draft.payload.recipientIds, ['1']);
    assert.equal(draft.validation.requiresTestSend, true);
    assert.equal(draft.validation.whatsappConnected, true);
});

test('contrato legado retorna string e contrato Detailed retorna metadados sem rede real', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalHistoryPath = process.env.VALEVERDE_AI_HISTORY_PATH;
    globalThis.fetch = async () => response(geminiPayload('Resposta em **Markdown** completa.'));
    process.env.VALEVERDE_AI_HISTORY_PATH = ':memory:';
    const geminiPath = require.resolve('../core/gemini');
    delete require.cache[geminiPath];
    const gemini = require('../core/gemini');
    gemini.configureProviderResolver(() => ({ provider: 'gemini', apiKey: 'test-key', model: 'test-model' }));
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalHistoryPath === undefined) delete process.env.VALEVERDE_AI_HISTORY_PATH;
        else process.env.VALEVERDE_AI_HISTORY_PATH = originalHistoryPath;
        delete require.cache[geminiPath];
    });

    const customers = [{ id: '1', nome: 'Ana', telefone: '22999999999', saldo_devedor: 100, status: 'Devedor' }];
    const legacy = await gemini.generateExecutiveReport(customers, [], [], []);
    const detailed = await gemini.answerQuestionDetailed(customers, [], [], [], 'Qual a situacao?', '', { sessionId: 'teste' });
    assert.equal(typeof legacy, 'string');
    assert.equal(detailed.text, 'Resposta em **Markdown** completa.');
    assert.equal(detailed.texto, detailed.text);
    assert.equal(detailed.provider, 'gemini');
    assert.equal(detailed.complete, true);
    assert.equal(detailed.metadados.continuacoes, 0);
    assert.equal(detailed.conversation.historyPersisted, true);
    assert.equal(gemini.getConversationHistory('teste').length, 2);
});

test('resolvedor multi-provider mantem status seguro e valida credenciais sem persistir chave', async (t) => {
    const originalHistoryPath = process.env.VALEVERDE_AI_HISTORY_PATH;
    process.env.VALEVERDE_AI_HISTORY_PATH = ':memory:';
    const geminiPath = require.resolve('../core/gemini');
    delete require.cache[geminiPath];
    const gemini = require('../core/gemini');
    t.after(() => {
        if (originalHistoryPath === undefined) delete process.env.VALEVERDE_AI_HISTORY_PATH;
        else process.env.VALEVERDE_AI_HISTORY_PATH = originalHistoryPath;
        delete require.cache[geminiPath];
    });

    assert.equal(gemini.getStatus().disponivel, false);
    gemini.configureProviderResolver(() => ({ provider: 'openai', apiKey: 'segredo-de-teste', model: '' }));
    const status = gemini.getStatus();
    assert.equal(status.disponivel, true);
    assert.equal(status.provider, 'openai');
    assert.equal(status.modelo, 'gpt-5.6-terra');
    assert.equal(JSON.stringify(status).includes('segredo-de-teste'), false);

    const openai = await gemini.validateProviderCredential({ provider: 'openai', apiKey: 'chave-teste' }, {
        openaiClient: {
            validateCredential: async (_key, model) => ({ valid: true, model, attempts: 1 }),
        },
    });
    assert.equal(openai.provider, 'openai');
    assert.equal(openai.model, 'gpt-5.6-terra');

    const google = await gemini.validateProviderCredential({ provider: 'gemini', apiKey: 'chave-teste' }, {
        geminiClient: {
            listModels: async () => ({
                attempts: 1,
                payload: { models: [{ name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }] },
            }),
        },
    });
    assert.equal(google.provider, 'gemini');
    assert.equal(google.model, 'gemini-3.5-flash');
    await assert.rejects(
        gemini.validateProviderCredential({ provider: 'outro', apiKey: 'nao-deve-ser-enviada' }),
        (error) => error.code === 'AI_PROVIDER_INVALID'
    );
});

test('generateContentDetailed seleciona OpenAI dinamicamente e preserva o contrato normalizado', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalHistoryPath = process.env.VALEVERDE_AI_HISTORY_PATH;
    let capturedRequest;
    globalThis.fetch = async (url, request) => {
        capturedRequest = { url, headers: request.headers, body: JSON.parse(request.body) };
        return response({
            id: 'resp_teste',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Resposta GPT completa.' }] }],
            usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
        });
    };
    process.env.VALEVERDE_AI_HISTORY_PATH = ':memory:';
    const geminiPath = require.resolve('../core/gemini');
    const openaiPath = require.resolve('../core/openai-client');
    delete require.cache[geminiPath];
    delete require.cache[openaiPath];
    const gemini = require('../core/gemini');
    gemini.configureProviderResolver(() => ({ provider: 'openai', apiKey: 'chave-openai-de-teste', model: '' }));
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalHistoryPath === undefined) delete process.env.VALEVERDE_AI_HISTORY_PATH;
        else process.env.VALEVERDE_AI_HISTORY_PATH = originalHistoryPath;
        delete require.cache[geminiPath];
        delete require.cache[openaiPath];
    });

    const detailed = await gemini.generateContentDetailed('Responda.', { maxOutputTokens: 300 });
    assert.equal(detailed.text, 'Resposta GPT completa.');
    assert.equal(detailed.provider, 'openai');
    assert.equal(detailed.provedor, 'openai');
    assert.equal(detailed.model, 'gpt-5.6-terra');
    assert.equal(detailed.metadados.uso.total_tokens, 7);
    assert.equal(capturedRequest.url, 'https://api.openai.com/v1/responses');
    assert.equal(capturedRequest.body.store, false);
    assert.equal(capturedRequest.headers.Authorization, 'Bearer chave-openai-de-teste');
});
