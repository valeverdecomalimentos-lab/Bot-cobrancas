const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';
const INCOMPLETE_MAX_TOKEN_REASONS = new Set(['MAX_OUTPUT_TOKENS', 'MAX_TOKENS', 'LENGTH']);

function boundedNumber(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    return headers[name] || headers[name.toLowerCase()] || '';
}

function retryDelay(response, attempt, random = Math.random) {
    const retryAfter = headerValue(response?.headers, 'retry-after');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) return Math.min(10000, Math.max(0, seconds * 1000));
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) return Math.min(10000, Math.max(0, date - Date.now()));
    }
    const base = Math.min(8000, 500 * (2 ** attempt));
    return Math.round(base * (0.8 + random() * 0.4));
}

function safeErrorDetail(body) {
    let detail = '';
    try {
        const parsed = JSON.parse(body);
        detail = parsed?.error?.message || parsed?.message || '';
    } catch {
        detail = String(body || '').replace(/\s+/g, ' ');
    }
    return String(detail)
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[chave omitida]')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [omitido]')
        .slice(0, 300);
}

function responseErrorMessage(status, body) {
    const detail = safeErrorDetail(body);
    return `OpenAI retornou HTTP ${status}${detail ? `: ${detail}` : '.'}`;
}

class OpenAIRequestError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'OpenAIRequestError';
        this.code = options.code || 'OPENAI_REQUEST_FAILED';
        this.status = options.status || 0;
        this.retryable = Boolean(options.retryable);
        this.cause = options.cause;
    }
}

class OpenAIIncompleteResponseError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'OpenAIIncompleteResponseError';
        this.code = 'OPENAI_INCOMPLETE_RESPONSE';
        this.finishReason = options.finishReason || 'MAX_OUTPUT_TOKENS';
        this.partialText = options.partialText || '';
        this.continuationCount = options.continuationCount || 0;
    }
}

async function fetchOpenAIJsonWithRetry(url, requestOptions = {}, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new OpenAIRequestError('Este ambiente nao possui suporte a requisicoes HTTP.', { code: 'FETCH_UNAVAILABLE' });
    }
    const timeoutMs = boundedNumber(options.timeoutMs, 45000, 25, 180000);
    const maxRetries = boundedNumber(options.maxRetries, 2, 0, 5);
    const sleep = options.sleep || wait;
    const random = options.random || Math.random;
    const externalSignal = options.signal;
    let totalAttempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        totalAttempts += 1;
        const controller = new AbortController();
        let timedOut = false;
        const onExternalAbort = () => controller.abort(externalSignal.reason);
        if (externalSignal) {
            if (externalSignal.aborted) controller.abort(externalSignal.reason);
            else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        try {
            const response = await fetchImpl(url, { ...requestOptions, signal: controller.signal });
            const body = await response.text();
            if (!response.ok) {
                const retryable = RETRYABLE_STATUS.has(response.status);
                if (retryable && attempt < maxRetries && !externalSignal?.aborted) {
                    clearTimeout(timer);
                    externalSignal?.removeEventListener?.('abort', onExternalAbort);
                    await sleep(retryDelay(response, attempt, random));
                    continue;
                }
                throw new OpenAIRequestError(responseErrorMessage(response.status, body), {
                    code: response.status === 401
                        ? 'OPENAI_KEY_INVALID'
                        : response.status === 429 ? 'OPENAI_RATE_LIMIT' : 'OPENAI_HTTP_ERROR',
                    status: response.status,
                    retryable,
                });
            }
            try {
                return { payload: JSON.parse(body), attempts: totalAttempts, status: response.status };
            } catch (error) {
                throw new OpenAIRequestError('OpenAI retornou uma resposta JSON invalida.', {
                    code: 'OPENAI_INVALID_JSON', status: response.status, cause: error,
                });
            }
        } catch (error) {
            if (error instanceof OpenAIRequestError) throw error;
            const wasExternallyAborted = Boolean(externalSignal?.aborted);
            const retryable = !wasExternallyAborted;
            if (retryable && attempt < maxRetries) {
                clearTimeout(timer);
                externalSignal?.removeEventListener?.('abort', onExternalAbort);
                await sleep(retryDelay(null, attempt, random));
                continue;
            }
            if (wasExternallyAborted) {
                throw new OpenAIRequestError('Solicitacao a OpenAI cancelada.', { code: 'OPENAI_ABORTED', cause: error });
            }
            if (timedOut || error?.name === 'AbortError') {
                throw new OpenAIRequestError(`OpenAI nao respondeu em ${timeoutMs} ms. Tente novamente.`, {
                    code: 'OPENAI_TIMEOUT', retryable: true, cause: error,
                });
            }
            throw new OpenAIRequestError('Falha de rede ao consultar a OpenAI. Verifique a conexao e tente novamente.', {
                code: 'OPENAI_NETWORK_ERROR', retryable: true, cause: error,
            });
        } finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener?.('abort', onExternalAbort);
        }
    }
    throw new OpenAIRequestError('Nao foi possivel consultar a OpenAI.', { retryable: true });
}

function extractOutputText(payload) {
    return (Array.isArray(payload?.output) ? payload.output : [])
        .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
        .filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
        .map((content) => content.text)
        .join('');
}

function extractRefusal(payload) {
    return (Array.isArray(payload?.output) ? payload.output : [])
        .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
        .filter((content) => content?.type === 'refusal')
        .map((content) => String(content.refusal || content.text || ''))
        .filter(Boolean)
        .join(' ');
}

function normalizeOpenAIFinishReason(payload) {
    const status = String(payload?.status || '').toUpperCase();
    if (status === 'COMPLETED') return 'STOP';
    if (status === 'INCOMPLETE') {
        return String(payload?.incomplete_details?.reason || payload?.incompleteDetails?.reason || 'INCOMPLETE').toUpperCase();
    }
    return status || 'UNKNOWN';
}

function mergeContinuation(existing, continuation) {
    const left = String(existing || '');
    const right = String(continuation || '');
    if (!left) return right;
    if (!right || left.endsWith(right)) return left;
    if (right.startsWith(left)) return right;
    const maximum = Math.min(left.length, right.length, 2000);
    for (let overlap = maximum; overlap >= 12; overlap -= 1) {
        if (left.slice(-overlap) === right.slice(0, overlap)) return left + right.slice(overlap);
    }
    return `${left}${/\s$/.test(left) || /^\s/.test(right) ? '' : '\n'}${right}`;
}

function continuationInstruction() {
    return [
        'Continue exatamente do ponto em que a resposta foi interrompida.',
        'Nao repita o texto anterior, nao reinicie secoes e nao acrescente um novo titulo apenas para a continuacao.',
        'Conclua todas as frases, listas, tabelas e blocos Markdown ainda abertos.',
    ].join(' ');
}

function supportsGpt5Controls(model) {
    return /^gpt-5(?:[.-]|$)/i.test(String(model || ''));
}

function addUsage(target, usage) {
    if (!usage || typeof usage !== 'object') return target;
    const result = { ...target };
    for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number') result[key] = Number(result[key] || 0) + value;
        else if (value && typeof value === 'object' && !Array.isArray(value)) result[key] = addUsage(result[key] || {}, value);
        else if (!(key in result)) result[key] = value;
    }
    return result;
}

class OpenAIRestClient {
    constructor(options = {}) {
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.sleep = options.sleep || wait;
        this.random = options.random || Math.random;
        this.baseUrl = String(options.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
        this.timeoutMs = boundedNumber(options.timeoutMs, 45000, 1000, 180000);
        this.maxRetries = boundedNumber(options.maxRetries, 2, 0, 5);
        this.maxContinuations = boundedNumber(options.maxContinuations, 3, 0, 8);
        this.maxTotalChars = boundedNumber(options.maxTotalChars, 80000, 2000, 500000);
    }

    requestOptions(options = {}) {
        return {
            fetchImpl: this.fetchImpl,
            sleep: this.sleep,
            random: this.random,
            timeoutMs: options.timeoutMs ?? this.timeoutMs,
            maxRetries: options.maxRetries ?? this.maxRetries,
            signal: options.signal,
        };
    }

    async validateCredential(apiKey, model = DEFAULT_OPENAI_MODEL, options = {}) {
        const cleanKey = String(apiKey || '').trim();
        const cleanModel = String(model || DEFAULT_OPENAI_MODEL).trim();
        if (!cleanKey) throw new OpenAIRequestError('Chave OpenAI nao encontrada.', { code: 'OPENAI_KEY_MISSING' });
        const response = await fetchOpenAIJsonWithRetry(`${this.baseUrl}/models/${encodeURIComponent(cleanModel)}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${cleanKey}` },
        }, this.requestOptions(options));
        return {
            valid: true,
            model: String(response.payload?.id || cleanModel),
            attempts: response.attempts,
        };
    }

    async generate(options = {}) {
        const apiKey = String(options.apiKey || '').trim();
        const model = String(options.model || DEFAULT_OPENAI_MODEL).trim();
        if (!apiKey) throw new OpenAIRequestError('Chave OpenAI nao encontrada.', { code: 'OPENAI_KEY_MISSING' });
        if (!model) throw new OpenAIRequestError('Modelo OpenAI nao definido.', { code: 'OPENAI_MODEL_MISSING' });

        const prompt = String(options.prompt || '');
        const systemInstruction = String(options.systemInstruction || '').trim();
        const maxOutputTokens = boundedNumber(options.maxOutputTokens, 4096, 128, 128000);
        const maxContinuations = boundedNumber(options.maxContinuations, this.maxContinuations, 0, 8);
        const inputItems = [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }];
        let text = '';
        let finishReason = '';
        let continuationCount = 0;
        let attempts = 0;
        let usageMetadata = {};

        while (true) {
            const requestBody = {
                model,
                store: false,
                input: inputItems,
                max_output_tokens: maxOutputTokens,
                ...(systemInstruction ? { instructions: systemInstruction } : {}),
            };
            if (supportsGpt5Controls(model)) {
                requestBody.reasoning = { effort: options.reasoningEffort || 'low' };
                requestBody.text = { verbosity: options.textVerbosity || 'medium' };
            } else if (Number.isFinite(Number(options.temperature))) {
                requestBody.temperature = Number(options.temperature);
            }

            const response = await fetchOpenAIJsonWithRetry(`${this.baseUrl}/responses`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(requestBody),
            }, this.requestOptions(options));
            attempts += response.attempts;
            const payload = response.payload || {};
            const chunk = extractOutputText(payload);
            const refusal = extractRefusal(payload);
            finishReason = normalizeOpenAIFinishReason(payload);
            usageMetadata = addUsage(usageMetadata, payload.usage || payload.usage_metadata || {});

            if (refusal) {
                throw new OpenAIRequestError(`A OpenAI recusou esta solicitacao: ${refusal.slice(0, 240)}`, {
                    code: 'OPENAI_REFUSAL',
                });
            }
            text = mergeContinuation(text, chunk);
            if (text.length > this.maxTotalChars) {
                throw new OpenAIIncompleteResponseError('A resposta ultrapassou o limite seguro de tamanho. Refine a pergunta.', {
                    finishReason: finishReason || 'SIZE_LIMIT', partialText: text.slice(0, this.maxTotalChars), continuationCount,
                });
            }

            if (INCOMPLETE_MAX_TOKEN_REASONS.has(finishReason)) {
                if (continuationCount >= maxContinuations) {
                    throw new OpenAIIncompleteResponseError(
                        `A OpenAI atingiu o limite de saida apos ${continuationCount + 1} partes. Refine a pergunta para obter uma resposta completa.`,
                        { finishReason, partialText: text, continuationCount }
                    );
                }
                const replayItems = Array.isArray(payload.output) ? payload.output.map((item) => ({ ...item })) : [];
                inputItems.push(...replayItems);
                inputItems.push({ role: 'user', content: [{ type: 'input_text', text: continuationInstruction() }] });
                continuationCount += 1;
                continue;
            }

            if (finishReason !== 'STOP') {
                throw new OpenAIIncompleteResponseError(`A resposta da OpenAI foi interrompida (${finishReason}) e nao sera exibida como completa.`, {
                    finishReason, partialText: text, continuationCount,
                });
            }
            if (!text.trim()) {
                throw new OpenAIRequestError('OpenAI nao retornou texto para esta solicitacao.', { code: 'OPENAI_EMPTY_TEXT' });
            }

            return {
                text: text.trim(),
                model,
                finishReason: 'STOP',
                complete: true,
                continuationCount,
                attempts,
                usageMetadata,
                provider: 'openai',
            };
        }
    }
}

module.exports = {
    DEFAULT_OPENAI_MODEL,
    OpenAIRestClient,
    OpenAIRequestError,
    OpenAIIncompleteResponseError,
    fetchOpenAIJsonWithRetry,
    extractOutputText,
    normalizeOpenAIFinishReason,
};
