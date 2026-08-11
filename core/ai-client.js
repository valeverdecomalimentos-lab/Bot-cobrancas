const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const INCOMPLETE_FINISH_REASONS = new Set(['MAX_TOKENS']);
const BLOCKED_FINISH_REASONS = new Set([
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'MALFORMED_FUNCTION_CALL',
    'IMAGE_SAFETY',
    'OTHER',
]);

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

function responseErrorMessage(status, body) {
    let detail = '';
    try {
        const parsed = JSON.parse(body);
        detail = parsed?.error?.message || parsed?.message || '';
    } catch {
        detail = String(body || '').replace(/\s+/g, ' ');
    }
    detail = detail
        .replace(/\bAIza[0-9A-Za-z_-]{10,}\b/g, '[chave omitida]')
        .replace(/\bAQ\.[0-9A-Za-z._-]{10,}\b/g, '[chave omitida]')
        .replace(/x-goog-api-key\s*[:=]\s*[^\s,;]+/gi, 'x-goog-api-key: [omitida]')
        .slice(0, 300);
    return `Gemini retornou HTTP ${status}${detail ? `: ${detail}` : '.'}`;
}

class GeminiRequestError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'GeminiRequestError';
        this.code = options.code || 'GEMINI_REQUEST_FAILED';
        this.status = options.status || 0;
        this.retryable = Boolean(options.retryable);
        this.cause = options.cause;
    }
}

class GeminiIncompleteResponseError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'GeminiIncompleteResponseError';
        this.code = 'GEMINI_INCOMPLETE_RESPONSE';
        this.finishReason = options.finishReason || 'MAX_TOKENS';
        this.partialText = options.partialText || '';
        this.continuationCount = options.continuationCount || 0;
    }
}

async function fetchJsonWithRetry(url, requestOptions = {}, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new GeminiRequestError('Este ambiente nao possui suporte a requisicoes HTTP.', { code: 'FETCH_UNAVAILABLE' });
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
                throw new GeminiRequestError(responseErrorMessage(response.status, body), {
                    code: response.status === 429 ? 'GEMINI_RATE_LIMIT' : 'GEMINI_HTTP_ERROR',
                    status: response.status,
                    retryable,
                });
            }
            try {
                return { payload: JSON.parse(body), attempts: totalAttempts, status: response.status };
            } catch (error) {
                throw new GeminiRequestError('Gemini retornou uma resposta JSON invalida.', {
                    code: 'GEMINI_INVALID_JSON',
                    status: response.status,
                    cause: error,
                });
            }
        } catch (error) {
            if (error instanceof GeminiRequestError) throw error;
            const wasExternallyAborted = Boolean(externalSignal?.aborted);
            const retryable = !wasExternallyAborted;
            if (retryable && attempt < maxRetries) {
                clearTimeout(timer);
                externalSignal?.removeEventListener?.('abort', onExternalAbort);
                await sleep(retryDelay(null, attempt, random));
                continue;
            }
            if (wasExternallyAborted) {
                throw new GeminiRequestError('Solicitacao a Gemini cancelada.', { code: 'GEMINI_ABORTED', cause: error });
            }
            if (timedOut || error?.name === 'AbortError') {
                throw new GeminiRequestError(`Gemini nao respondeu em ${timeoutMs} ms. Tente novamente.`, {
                    code: 'GEMINI_TIMEOUT', retryable: true, cause: error,
                });
            }
            throw new GeminiRequestError('Falha de rede ao consultar a Gemini. Verifique a conexao e tente novamente.', {
                code: 'GEMINI_NETWORK_ERROR', retryable: true, cause: error,
            });
        } finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener?.('abort', onExternalAbort);
        }
    }
    throw new GeminiRequestError('Nao foi possivel consultar a Gemini.', { retryable: true });
}

function normalizeFinishReason(candidate) {
    return String(candidate?.finishReason || candidate?.finish_reason || '').toUpperCase();
}

function candidateText(candidate) {
    return (candidate?.content?.parts || [])
        .map((part) => typeof part?.text === 'string' ? part.text : '')
        .join('');
}

function extractCandidate(payload) {
    const candidate = payload?.candidates?.[0];
    if (candidate) return candidate;
    const blockReason = payload?.promptFeedback?.blockReason || payload?.prompt_feedback?.block_reason;
    if (blockReason) {
        throw new GeminiRequestError(`A Gemini bloqueou a solicitacao (${blockReason}). Revise o conteudo e tente novamente.`, {
            code: 'GEMINI_PROMPT_BLOCKED',
        });
    }
    throw new GeminiRequestError('Gemini nao retornou candidatos para esta solicitacao.', { code: 'GEMINI_EMPTY_RESPONSE' });
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

class GeminiRestClient {
    constructor(options = {}) {
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.sleep = options.sleep || wait;
        this.random = options.random || Math.random;
        this.baseUrl = options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
        this.timeoutMs = boundedNumber(options.timeoutMs ?? process.env.GEMINI_TIMEOUT_MS, 45000, 1000, 180000);
        this.maxRetries = boundedNumber(options.maxRetries ?? process.env.GEMINI_MAX_RETRIES, 2, 0, 5);
        this.maxContinuations = boundedNumber(options.maxContinuations ?? process.env.GEMINI_MAX_CONTINUATIONS, 3, 0, 8);
        this.maxTotalChars = boundedNumber(options.maxTotalChars ?? process.env.GEMINI_MAX_TOTAL_CHARS, 80000, 2000, 500000);
    }

    async listModels(apiKey, options = {}) {
        return fetchJsonWithRetry(`${this.baseUrl}/models?pageSize=1000`, {
            method: 'GET',
            headers: { 'x-goog-api-key': apiKey },
        }, this.requestOptions(options));
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

    async generate(options = {}) {
        const apiKey = String(options.apiKey || '');
        const model = String(options.model || '');
        if (!apiKey) throw new GeminiRequestError('Chave Gemini nao encontrada.', { code: 'GEMINI_KEY_MISSING' });
        if (!model) throw new GeminiRequestError('Modelo Gemini nao definido.', { code: 'GEMINI_MODEL_MISSING' });

        const maxOutputTokens = boundedNumber(options.maxOutputTokens, 4096, 128, 65536);
        const maxContinuations = boundedNumber(options.maxContinuations, this.maxContinuations, 0, 8);
        const generationConfig = {
            maxOutputTokens,
            ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
        };
        // A familia Gemini 3.x pode rejeitar os controles de amostragem legados.
        if (!/^gemini-3(?:[.-]|$)/i.test(model) && Number.isFinite(Number(options.temperature))) {
            generationConfig.temperature = Number(options.temperature);
        }
        const contents = Array.isArray(options.contents)
            ? options.contents.map((content) => ({ ...content, parts: [...(content.parts || [])] }))
            : [{ role: 'user', parts: [{ text: String(options.prompt || '') }] }];
        const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
        const systemInstruction = String(options.systemInstruction || '').trim();
        let text = '';
        let finishReason = '';
        let continuationCount = 0;
        let attempts = 0;
        let usageMetadata = {};

        while (true) {
            const response = await fetchJsonWithRetry(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                },
                body: JSON.stringify({
                    contents,
                    generationConfig,
                    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
                }),
            }, this.requestOptions(options));
            attempts += response.attempts;
            const candidate = extractCandidate(response.payload);
            const chunk = candidateText(candidate);
            finishReason = normalizeFinishReason(candidate);
            usageMetadata = response.payload.usageMetadata || response.payload.usage_metadata || usageMetadata;

            if (!chunk.trim()) {
                throw new GeminiRequestError('Gemini nao retornou texto para esta solicitacao.', { code: 'GEMINI_EMPTY_TEXT' });
            }
            text = mergeContinuation(text, chunk);
            if (text.length > this.maxTotalChars) {
                throw new GeminiIncompleteResponseError('A resposta ultrapassou o limite seguro de tamanho. Refine a pergunta.', {
                    finishReason: finishReason || 'SIZE_LIMIT', partialText: text.slice(0, this.maxTotalChars), continuationCount,
                });
            }

            if (INCOMPLETE_FINISH_REASONS.has(finishReason)) {
                if (continuationCount >= maxContinuations) {
                    throw new GeminiIncompleteResponseError(
                        `A Gemini atingiu o limite de saida apos ${continuationCount + 1} partes. Refine a pergunta para obter uma resposta completa.`,
                        { finishReason, partialText: text, continuationCount }
                    );
                }
                contents.push({
                    role: 'model',
                    parts: (candidate.content?.parts || []).map((part) => ({ ...part })),
                });
                contents.push({ role: 'user', parts: [{ text: continuationInstruction() }] });
                continuationCount += 1;
                continue;
            }

            if (BLOCKED_FINISH_REASONS.has(finishReason)) {
                throw new GeminiIncompleteResponseError(`A resposta da Gemini foi interrompida (${finishReason}) e nao sera exibida como completa.`, {
                    finishReason, partialText: text, continuationCount,
                });
            }

            return {
                text: text.trim(),
                model,
                finishReason: finishReason || 'STOP',
                complete: true,
                continuationCount,
                attempts,
                usageMetadata,
            };
        }
    }
}

module.exports = {
    GeminiRestClient,
    GeminiRequestError,
    GeminiIncompleteResponseError,
    fetchJsonWithRetry,
    mergeContinuation,
    normalizeFinishReason,
};
