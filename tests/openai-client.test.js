const test = require('node:test');
const assert = require('node:assert/strict');

const {
    OpenAIRestClient,
    OpenAIIncompleteResponseError,
    OpenAIRequestError,
} = require('../core/openai-client');

function response(payload, status = 200, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers[String(name).toLowerCase()] || '' },
        text: async () => JSON.stringify(payload),
    };
}

function openaiPayload(text, status = 'completed', reason = '') {
    return {
        id: `resp_${status}`,
        status,
        incomplete_details: reason ? { reason } : null,
        output: [{
            id: `msg_${status}`,
            type: 'message',
            role: 'assistant',
            status,
            content: [{ type: 'output_text', text, annotations: [] }],
        }],
        usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
    };
}

test('OpenAIRestClient usa Responses API sem armazenamento e continua limite de tokens', async () => {
    const requests = [];
    const payloads = [
        openaiPayload('Primeira parte com trecho compartilhado', 'incomplete', 'max_output_tokens'),
        openaiPayload('trecho compartilhado e conclusao.'),
    ];
    const client = new OpenAIRestClient({
        fetchImpl: async (url, request) => {
            requests.push({ url, headers: request.headers, body: JSON.parse(request.body) });
            return response(payloads.shift());
        },
        maxRetries: 0,
    });

    const result = await client.generate({
        apiKey: 'sk-chave-apenas-de-teste',
        model: 'gpt-5.6-terra',
        prompt: 'Analise os dados.',
        systemInstruction: 'Responda em portugues.',
        maxOutputTokens: 256,
    });

    assert.equal(result.text, 'Primeira parte com trecho compartilhado e conclusao.');
    assert.equal(result.provider, 'openai');
    assert.equal(result.complete, true);
    assert.equal(result.continuationCount, 1);
    assert.equal(result.attempts, 2);
    assert.equal(result.usageMetadata.total_tokens, 24);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(requests[0].body.store, false);
    assert.equal(requests[0].body.instructions, 'Responda em portugues.');
    assert.equal(requests[0].body.reasoning.effort, 'low');
    assert.equal(requests[0].body.text.verbosity, 'medium');
    assert.equal(requests[1].body.input.length, 3);
    assert.equal(requests[1].body.input[1].type, 'message');
    assert.match(requests[1].body.input[2].content[0].text, /Continue exatamente/);
});

test('OpenAIRestClient repete falha transitoria e valida a credencial pelo modelo', async () => {
    let calls = 0;
    const delays = [];
    const client = new OpenAIRestClient({
        fetchImpl: async (url, request) => {
            calls += 1;
            assert.equal(request.headers.Authorization, 'Bearer chave-teste');
            assert.equal(url, 'https://api.openai.com/v1/models/gpt-5.6-terra');
            if (calls === 1) return response({ error: { message: 'ocupado' } }, 429, { 'retry-after': '0' });
            return response({ id: 'gpt-5.6-terra', object: 'model' });
        },
        sleep: async (milliseconds) => delays.push(milliseconds),
        random: () => 0,
        maxRetries: 2,
    });

    const validation = await client.validateCredential('chave-teste');
    assert.equal(validation.valid, true);
    assert.equal(validation.model, 'gpt-5.6-terra');
    assert.equal(validation.attempts, 2);
    assert.equal(delays.length, 1);
});

test('OpenAIRestClient nunca apresenta resposta cortada como completa', async () => {
    const client = new OpenAIRestClient({
        fetchImpl: async () => response(openaiPayload('Texto ainda incompleto', 'incomplete', 'max_output_tokens')),
        maxRetries: 0,
        maxContinuations: 0,
    });

    await assert.rejects(
        client.generate({ apiKey: 'chave-teste', prompt: 'Pergunta', maxContinuations: 0 }),
        (error) => error instanceof OpenAIIncompleteResponseError
            && error.code === 'OPENAI_INCOMPLETE_RESPONSE'
            && error.partialText === 'Texto ainda incompleto'
    );
});

test('OpenAIRestClient omite controles GPT-5 em modelos que podem ser incompativeis', async () => {
    let body;
    const client = new OpenAIRestClient({
        fetchImpl: async (_url, request) => {
            body = JSON.parse(request.body);
            return response(openaiPayload('Resposta completa.'));
        },
        maxRetries: 0,
    });

    await client.generate({ apiKey: 'chave-teste', model: 'gpt-4.1', prompt: 'Pergunta', temperature: 0.3 });
    assert.equal(body.reasoning, undefined);
    assert.equal(body.text, undefined);
    assert.equal(body.temperature, 0.3);
});

test('erros HTTP da OpenAI nao propagam uma chave presente na resposta remota', async () => {
    const client = new OpenAIRestClient({
        fetchImpl: async () => response({ error: { message: 'Invalid key sk-segredototal123456789' } }, 401),
        maxRetries: 0,
    });

    await assert.rejects(
        client.validateCredential('sk-segredototal123456789'),
        (error) => error instanceof OpenAIRequestError
            && error.code === 'OPENAI_KEY_INVALID'
            && !error.message.includes('sk-segredototal123456789')
    );
});
