const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = Object.freeze(['gemini', 'openai']);
const DEFAULT_MODELS = Object.freeze({
    gemini: 'gemini-3.6-flash',
    openai: 'gpt-5.6-terra',
});

function normalizeProvider(value) {
    const provider = String(value || '').trim().toLowerCase();
    if (!PROVIDERS.includes(provider)) {
        throw new Error('Provedor de IA inválido. Escolha Gemini ou OpenAI.');
    }
    return provider;
}

function normalizeModel(value, provider) {
    const model = String(value || DEFAULT_MODELS[provider] || '').trim();
    if (!model || model.length > 120 || !/^[a-zA-Z0-9._:/-]+$/.test(model)) {
        throw new Error('Modelo de IA inválido.');
    }
    return model;
}

function normalizeApiKey(value, provider, options = {}) {
    const apiKey = typeof value === 'string' ? value : '';
    if (!apiKey && options.allowEmpty) return '';
    if (apiKey.length < 20 || apiKey.length > 512 || /\s|[\u0000-\u001f\u007f]/.test(apiKey)) {
        throw new Error('A chave de API informada é inválida.');
    }
    if (provider === 'openai' && !apiKey.startsWith('sk-')) {
        throw new Error('A chave da OpenAI deve começar com "sk-".');
    }
    return apiKey;
}

function normalizeCredentialInput(input = {}, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Configuração de IA inválida.');
    }
    const provider = normalizeProvider(input.provider);
    return {
        provider,
        model: normalizeModel(input.model || options.fallbackModel, provider),
        apiKey: normalizeApiKey(input.apiKey, provider, { allowEmpty: options.allowEmptyApiKey === true }),
    };
}

function emptyData() {
    return {
        version: 1,
        activeProvider: 'gemini',
        models: { ...DEFAULT_MODELS },
        ciphertext: {},
    };
}

function maskApiKey(apiKey) {
    const suffix = String(apiKey || '').slice(-4);
    return suffix ? `••••••••${suffix}` : '';
}

function cloneData(data) {
    return {
        version: Number(data?.version || 1),
        activeProvider: PROVIDERS.includes(data?.activeProvider) ? data.activeProvider : 'gemini',
        models: { ...DEFAULT_MODELS, ...(data?.models || {}) },
        ciphertext: { ...(data?.ciphertext || {}) },
    };
}

function publicCredentialError(provider) {
    return `Não foi possível abrir a credencial segura de ${provider === 'gemini' ? 'Gemini' : 'OpenAI'}.`;
}

class AiCredentialStore {
    constructor(options = {}) {
        this.filePath = String(options.filePath || '').trim();
        this.safeStorage = options.safeStorage;
        if (!this.filePath) throw new Error('Caminho do cofre de IA não informado.');
        this.loaded = false;
        this.data = emptyData();
    }

    _assertEncryptionAvailable() {
        const storage = this.safeStorage;
        if (!storage
            || typeof storage.isEncryptionAvailable !== 'function'
            || typeof storage.encryptString !== 'function'
            || typeof storage.decryptString !== 'function'
            || !storage.isEncryptionAvailable()) {
            throw new Error('O armazenamento seguro do sistema operacional não está disponível.');
        }

        if (typeof storage.getSelectedStorageBackend === 'function') {
            let backend = '';
            try {
                backend = String(storage.getSelectedStorageBackend() || '').trim().toLowerCase();
            } catch {
                throw new Error('Não foi possível validar o armazenamento seguro do sistema operacional.');
            }
            if (backend === 'basic_text') {
                throw new Error('O backend basic_text não oferece criptografia segura para a chave de API.');
            }
        }
    }

    _load() {
        if (this.loaded) return this.data;
        this.loaded = true;
        if (!fs.existsSync(this.filePath)) return this.data;

        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            const activeProvider = PROVIDERS.includes(parsed?.activeProvider)
                ? parsed.activeProvider
                : 'gemini';
            const models = {};
            for (const provider of PROVIDERS) {
                try {
                    models[provider] = normalizeModel(parsed?.models?.[provider], provider);
                } catch {
                    models[provider] = DEFAULT_MODELS[provider];
                }
            }
            const ciphertext = {};
            for (const provider of PROVIDERS) {
                const value = parsed?.ciphertext?.[provider];
                if (typeof value === 'string' && value) {
                    ciphertext[provider] = value;
                }
            }
            this.data = { version: 1, activeProvider, models, ciphertext };
        } catch {
            throw new Error('O cofre de credenciais de IA está corrompido ou ilegível.');
        }
        return this.data;
    }

    _isCanonicalBase64(value) {
        try {
            const decoded = Buffer.from(value, 'base64');
            return decoded.length > 0 && decoded.toString('base64') === value;
        } catch {
            return false;
        }
    }

    _decrypt(provider) {
        const encrypted = this._load().ciphertext[provider];
        if (!encrypted) return '';
        this._assertEncryptionAvailable();
        try {
            if (!this._isCanonicalBase64(encrypted)) throw new Error('ciphertext inválido');
            const apiKey = this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
            return normalizeApiKey(apiKey, provider);
        } catch {
            throw new Error(publicCredentialError(provider));
        }
    }

    _persist() {
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2), {
                encoding: 'utf8',
                mode: 0o600,
            });
            fs.renameSync(temporaryPath, this.filePath);
            if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
        } finally {
            if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        }
    }

    prepare(input = {}) {
        const provider = normalizeProvider(input.provider);
        const data = this._load();
        return normalizeCredentialInput(input, {
            allowEmptyApiKey: true,
            fallbackModel: data.models[provider],
        });
    }

    resolveCandidate(input = {}) {
        this._assertEncryptionAvailable();
        const prepared = this.prepare(input);
        const apiKey = prepared.apiKey || this._decrypt(prepared.provider);
        if (!apiKey) {
            throw new Error('Informe a chave de API antes de ativar este provedor.');
        }
        return { ...prepared, apiKey };
    }

    getPublicStatus() {
        const data = this._load();
        const providers = {};
        for (const provider of PROVIDERS) {
            const hasCiphertext = Boolean(data.ciphertext[provider]);
            let configured = hasCiphertext;
            let maskedKey = '';
            let error = '';
            if (hasCiphertext) {
                try {
                    maskedKey = maskApiKey(this._decrypt(provider));
                } catch {
                    configured = false;
                    error = publicCredentialError(provider);
                }
            }
            providers[provider] = {
                configured,
                model: data.models[provider],
                maskedKey,
                error,
                erro: error,
            };
        }
        return {
            activeProvider: data.activeProvider,
            providers,
        };
    }

    getActiveCredential() {
        const data = this._load();
        const provider = data.activeProvider;
        const apiKey = this._decrypt(provider);
        if (!apiKey) return null;
        return {
            provider,
            model: data.models[provider],
            apiKey,
        };
    }

    save(input = {}) {
        this._assertEncryptionAvailable();
        const prepared = this.resolveCandidate(input);
        const data = this._load();
        let buffer;
        try {
            buffer = this.safeStorage.encryptString(prepared.apiKey);
        } catch {
            throw new Error('Não foi possível proteger a chave de API no sistema operacional.');
        }
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            throw new Error('O armazenamento seguro retornou uma credencial inválida.');
        }

        const previousData = cloneData(data);
        data.activeProvider = prepared.provider;
        data.models[prepared.provider] = prepared.model;
        data.ciphertext[prepared.provider] = buffer.toString('base64');
        try {
            this._persist();
        } catch (error) {
            this.data = previousData;
            throw error;
        }
        return this.getPublicStatus();
    }

    remove(providerValue) {
        const provider = normalizeProvider(providerValue);
        const data = this._load();
        const previousData = cloneData(data);
        delete data.ciphertext[provider];
        if (data.activeProvider === provider) {
            const fallback = PROVIDERS.find((candidate) => data.ciphertext[candidate]);
            if (fallback) data.activeProvider = fallback;
        }
        try {
            this._persist();
        } catch (error) {
            this.data = previousData;
            throw error;
        }
        return this.getPublicStatus();
    }
}

module.exports = {
    AiCredentialStore,
    DEFAULT_MODELS,
    PROVIDERS,
    maskApiKey,
    normalizeCredentialInput,
};
