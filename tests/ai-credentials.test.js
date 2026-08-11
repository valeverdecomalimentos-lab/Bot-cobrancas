const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    AiCredentialStore,
    DEFAULT_MODELS,
    normalizeCredentialInput,
} = require('../core/ai-credentials');

function createMockSafeStorage(options = {}) {
    const prefix = Buffer.from('secure-v1:');
    return {
        isEncryptionAvailable: () => options.available !== false,
        getSelectedStorageBackend: () => options.backend || 'dpapi',
        encryptString(value) {
            return Buffer.concat([prefix, Buffer.from(String(value), 'utf8')]).reverse();
        },
        decryptString(value) {
            const decoded = Buffer.from(value).reverse();
            assert.deepEqual(decoded.subarray(0, prefix.length), prefix);
            return decoded.subarray(prefix.length).toString('utf8');
        },
    };
}

function withVault(run, storageOptions = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-ai-vault-'));
    const filePath = path.join(directory, 'ai-credentials.json');
    try {
        return run({
            filePath,
            store: new AiCredentialStore({ filePath, safeStorage: createMockSafeStorage(storageOptions) }),
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('cifra a chave, persiste apenas Base64 e expõe somente os quatro últimos caracteres', () => {
    withVault(({ filePath, store }) => {
        const secret = 'AIzaSyExampleGeminiSecret1234';
        const status = store.save({ provider: 'gemini', apiKey: secret, model: '' });
        const raw = fs.readFileSync(filePath, 'utf8');
        const persisted = JSON.parse(raw);

        assert.equal(raw.includes(secret), false);
        assert.equal(persisted.activeProvider, 'gemini');
        assert.equal(persisted.models.gemini, DEFAULT_MODELS.gemini);
        assert.match(persisted.ciphertext.gemini, /^[A-Za-z0-9+/]+={0,2}$/);
        assert.deepEqual(status.providers.gemini, {
            configured: true,
            model: DEFAULT_MODELS.gemini,
            maskedKey: '••••••••1234',
            error: '',
            erro: '',
        });
        assert.equal(JSON.stringify(status).includes(secret), false);
        assert.deepEqual(store.getActiveCredential(), {
            provider: 'gemini',
            model: DEFAULT_MODELS.gemini,
            apiKey: secret,
        });
    });
});

test('reabre o cofre e preserva a chave quando o campo vier vazio', () => {
    withVault(({ filePath, store }) => {
        const secret = 'sk-proj-exampleOpenAISecret9876';
        store.save({ provider: 'openai', apiKey: secret });
        const reopened = new AiCredentialStore({ filePath, safeStorage: createMockSafeStorage() });

        assert.deepEqual(reopened.resolveCandidate({ provider: 'openai', apiKey: '', model: 'gpt-5.6-terra-mini' }), {
            provider: 'openai',
            model: 'gpt-5.6-terra-mini',
            apiKey: secret,
        });
        reopened.save({ provider: 'openai', apiKey: '', model: 'gpt-5.6-terra-mini' });
        assert.deepEqual(reopened.getActiveCredential(), {
            provider: 'openai',
            model: 'gpt-5.6-terra-mini',
            apiKey: secret,
        });
        assert.equal(reopened.getPublicStatus().providers.openai.maskedKey, '••••••••9876');
    });
});

test('mantém credenciais separadas, troca o provedor ativo e remove sem expor chaves', () => {
    withVault(({ store }) => {
        store.save({ provider: 'gemini', apiKey: 'AIzaSyExampleGeminiSecret1111' });
        store.save({ provider: 'openai', apiKey: 'sk-proj-exampleOpenAISecret2222' });

        assert.equal(store.getPublicStatus().activeProvider, 'openai');
        const status = store.remove('openai');
        assert.equal(status.activeProvider, 'gemini');
        assert.equal(status.providers.openai.configured, false);
        assert.equal(status.providers.openai.maskedKey, '');
        assert.equal(store.getActiveCredential().apiKey.endsWith('1111'), true);
    });
});

test('recusa ativação sem uma chave previamente armazenada', () => {
    withVault(({ store }) => {
        assert.throws(
            () => store.save({ provider: 'openai', apiKey: '' }),
            /Informe a chave de API/,
        );
    });
});

test('recusa armazenamento sem criptografia real disponível', () => {
    withVault(({ store }) => {
        assert.throws(
            () => store.save({ provider: 'gemini', apiKey: 'AIzaSyExampleGeminiSecret1234' }),
            /armazenamento seguro.*não está disponível/i,
        );
        assert.equal(fs.existsSync(store.filePath), false);
    }, { available: false });

    withVault(({ store }) => {
        assert.throws(
            () => store.save({ provider: 'openai', apiKey: 'sk-proj-exampleOpenAISecret1234' }),
            /basic_text/,
        );
        assert.equal(fs.existsSync(store.filePath), false);
    }, { backend: 'basic_text' });
});

test('aceita chaves Gemini opacas sem depender de um prefixo específico', () => {
    const modernGeminiKey = 'AQ.FakeModernGeminiCredential_1234567890';

    assert.deepEqual(
        normalizeCredentialInput({ provider: 'gemini', apiKey: modernGeminiKey }),
        {
            provider: 'gemini',
            model: DEFAULT_MODELS.gemini,
            apiKey: modernGeminiKey,
        },
    );
});

test('valida provedor, modelo e formato mínimo das chaves', () => {
    assert.throws(
        () => normalizeCredentialInput({ provider: 'outro', apiKey: 'qualquer-chave-muito-longa' }),
        /Provedor de IA inválido/,
    );
    assert.throws(
        () => normalizeCredentialInput({ provider: 'gemini', apiKey: '' }),
        /chave de API.*inválida/i,
    );
    assert.throws(
        () => normalizeCredentialInput({ provider: 'gemini', apiKey: 'AQ.curta' }),
        /chave de API.*inválida/i,
    );
    assert.throws(
        () => normalizeCredentialInput({ provider: 'gemini', apiKey: 'AQ.Fake Gemini Credential 1234567890' }),
        /chave de API.*inválida/i,
    );
    assert.throws(
        () => normalizeCredentialInput({ provider: 'gemini', apiKey: 'AQ.FakeGeminiCredential1234567890\n' }),
        /chave de API.*inválida/i,
    );
    assert.throws(
        () => normalizeCredentialInput({ provider: 'openai', apiKey: 'AQ.FakeOpenAICredential1234567890' }),
        /deve começar com "sk-"/,
    );
    assert.throws(
        () => normalizeCredentialInput({ provider: 'openai', apiKey: 'sk-proj chave com espaço' }),
        /chave de API.*inválida/i,
    );
    assert.throws(
        () => normalizeCredentialInput({ provider: 'openai', apiKey: 'sk-proj-validKey123456789', model: '../ modelo' }),
        /Modelo de IA inválido/,
    );
});

test('falha de cifragem não grava arquivo nem deixa temporário', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-ai-vault-fail-'));
    const filePath = path.join(directory, 'ai-credentials.json');
    const safeStorage = createMockSafeStorage();
    safeStorage.encryptString = () => { throw new Error('segredo do sistema'); };
    const store = new AiCredentialStore({ filePath, safeStorage });
    try {
        assert.throws(
            () => store.save({ provider: 'gemini', apiKey: 'AIzaSyExampleGeminiSecret1234' }),
            /Não foi possível proteger/,
        );
        assert.deepEqual(fs.readdirSync(directory), []);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('isola credencial inativa corrompida e preserva o status do provedor ativo', () => {
    withVault(({ filePath, store }) => {
        const geminiSecret = 'AIzaSyExampleGeminiSecret1111';
        const openAiSecret = 'sk-proj-exampleOpenAISecret2222';
        store.save({ provider: 'gemini', apiKey: geminiSecret });
        store.save({ provider: 'openai', apiKey: openAiSecret });

        const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        persisted.ciphertext.gemini = Buffer.from('not-a-safe-storage-payload').toString('base64');
        fs.writeFileSync(filePath, JSON.stringify(persisted, null, 2), 'utf8');

        const reopened = new AiCredentialStore({ filePath, safeStorage: createMockSafeStorage() });
        const status = reopened.getPublicStatus();
        assert.equal(status.activeProvider, 'openai');
        assert.deepEqual(status.providers.openai, {
            configured: true,
            model: DEFAULT_MODELS.openai,
            maskedKey: '••••••••2222',
            error: '',
            erro: '',
        });
        assert.equal(status.providers.gemini.configured, false);
        assert.equal(status.providers.gemini.maskedKey, '');
        assert.match(status.providers.gemini.error, /credencial segura de Gemini/);
        assert.equal(status.providers.gemini.erro, status.providers.gemini.error);
        assert.equal(JSON.stringify(status).includes(geminiSecret), false);
        assert.equal(JSON.stringify(status).includes(openAiSecret), false);
        assert.deepEqual(reopened.getActiveCredential(), {
            provider: 'openai',
            model: DEFAULT_MODELS.openai,
            apiKey: openAiSecret,
        });
    });
});

test('restaura o estado em memória quando a persistência falha durante save', () => {
    withVault(({ filePath, store }) => {
        store.save({ provider: 'gemini', apiKey: 'AIzaSyExampleGeminiSecret1111' });
        const statusBefore = store.getPublicStatus();
        const fileBefore = fs.readFileSync(filePath, 'utf8');
        const persist = store._persist;
        store._persist = () => { throw new Error('falha de disco simulada'); };

        assert.throws(
            () => store.save({ provider: 'openai', apiKey: 'sk-proj-exampleOpenAISecret2222' }),
            /falha de disco simulada/,
        );
        store._persist = persist;

        assert.deepEqual(store.getPublicStatus(), statusBefore);
        assert.equal(store.getActiveCredential().provider, 'gemini');
        assert.equal(fs.readFileSync(filePath, 'utf8'), fileBefore);
    });
});

test('restaura o estado em memória quando a persistência falha durante remove', () => {
    withVault(({ filePath, store }) => {
        store.save({ provider: 'gemini', apiKey: 'AIzaSyExampleGeminiSecret1111' });
        store.save({ provider: 'openai', apiKey: 'sk-proj-exampleOpenAISecret2222' });
        const statusBefore = store.getPublicStatus();
        const fileBefore = fs.readFileSync(filePath, 'utf8');
        const persist = store._persist;
        store._persist = () => { throw new Error('falha de disco simulada'); };

        assert.throws(() => store.remove('openai'), /falha de disco simulada/);
        store._persist = persist;

        assert.deepEqual(store.getPublicStatus(), statusBefore);
        assert.equal(store.getActiveCredential().provider, 'openai');
        assert.equal(fs.readFileSync(filePath, 'utf8'), fileBefore);
    });
});
