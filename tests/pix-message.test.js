const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const message = require('../core/message');
const sender = require('../core/sender');
const {
    inferPixType,
    normalizePixSettings,
    validatePixSettings,
} = require('../core/pix');

const cliente = {
    nome: 'Maria da Silva',
    telefone: '22999999999',
    saldo_devedor: 125.5,
};

test('normaliza a chavePix legada e infere telefone quando nao e um CPF valido', () => {
    const pix = normalizePixSettings({
        chavePix: '22998628769',
        nomeFavorecido: '  Israel   Felipe  ',
    });

    assert.deepEqual(pix, {
        nomeFavorecido: 'Israel Felipe',
        chave: '22998628769',
        tipo: 'telefone',
    });
    assert.equal(inferPixType('financeiro@empresa.com.br'), 'email');
    assert.equal(normalizePixSettings(
        { chavePix: 'financeiro@empresa.com.br' },
        { chave: '22998628769', tipo: 'telefone' },
    ).tipo, 'email');
});

test('valida o formato conforme o tipo de chave selecionado', () => {
    const resultado = validatePixSettings({
        nomeFavorecido: 'Vale Verde',
        chave: 'email-invalido',
        tipo: 'email',
    });

    assert.equal(resultado.valid, false);
    assert.match(resultado.errors.chave, /e-mail valido/i);
    assert.equal(validatePixSettings({
        nomeFavorecido: 'Vale Verde',
        chave: '529abc98224725',
        tipo: 'cpf',
    }).valid, false);
});

test('resolve todos os placeholders PIX com a configuracao informada', () => {
    const texto = message.montarComTexto(
        cliente,
        'Favorecido: {{pix_nome_favorecido}}\nTipo: {{pix_tipo}}\nChave: {{pix_chave}}\nValor: R$ {{valor}}\n\n!! Mensagem automatica !!',
        false,
        {
            nomeFavorecido: 'Vale Verde Alimentos',
            chave: 'financeiro@valeverde.com.br',
            tipo: 'email',
        },
    );

    assert.match(texto, /Favorecido: Vale Verde Alimentos/);
    assert.match(texto, /Tipo: E-mail/);
    assert.match(texto, /Chave: financeiro@valeverde\.com\.br/);
    assert.doesNotMatch(texto, /\{\{pix_/);
});

test('impede envio com placeholder PIX quando os dados estao invalidos', () => {
    assert.throws(
        () => message.montarComTexto(
            cliente,
            'Pague em {{pix_chave}} para {{pix_nome_favorecido}}',
            false,
            { nomeFavorecido: '', chave: 'invalida', tipo: 'aleatoria' },
        ),
        /Dados PIX incompletos ou invalidos/,
    );
});

test('nao altera templates personalizados que nao usam placeholders PIX', () => {
    const template = 'Pagamento combinado diretamente com o financeiro.';
    const texto = message.montarComTexto(
        cliente,
        template,
        true,
        { nomeFavorecido: '', chave: '', tipo: 'aleatoria' },
    );

    assert.equal(texto, template);
});

test('entrega exatamente o template esperado, substituindo somente placeholders', () => {
    const template = [
        'Olá! {{nome}}',
        'Temos ofertas especiais preparadas para você aqui na Vale Verde. Venha nos visitar e confira as novidades em nossos setores para abastecer a sua casa com economia e qualidade. Esperamos a sua visita!',
    ].join('\n');

    assert.equal(
        message.montarComTexto(
            { ...cliente, nome: '*Excluído * Rogerinho ( pedreiro )' },
            template,
            true,
        ),
        [
            'Olá! *Excluído * Rogerinho ( pedreiro )',
            'Temos ofertas especiais preparadas para você aqui na Vale Verde. Venha nos visitar e confira as novidades em nossos setores para abastecer a sua casa com economia e qualidade. Esperamos a sua visita!',
        ].join('\n'),
    );
});

test('sender usa os dados PIX da campanha no texto realmente enviado', async () => {
    const enviados = [];
    const client = {
        isRegisteredUser: async () => true,
        sendMessage: async (telefone, texto) => enviados.push({ telefone, texto }),
    };
    const resultados = await sender.enviarMensagens(
        [cliente],
        client,
        {
            tipo: 'promocao',
            mensagem: 'PIX: {{pix_chave}} — {{pix_nome_favorecido}}',
            mostrarRodapeContato: false,
            pix: {
                nomeFavorecido: 'Vale Verde Alimentos',
                chave: 'financeiro@valeverde.com.br',
                tipo: 'email',
            },
        },
        { delay: false },
    );

    assert.equal(resultados[0].statusEnvio, 'Enviado');
    assert.equal(enviados[0].texto, 'PIX: financeiro@valeverde.com.br — Vale Verde Alimentos');
});

test('teste, promocao e cobranca enviam somente a mensagem personalizada resolvida', async () => {
    const enviados = [];
    const client = {
        isRegisteredUser: async () => true,
        sendMessage: async (telefone, texto) => enviados.push({ telefone, texto }),
    };
    const template = 'Olá! {{nome}}\nOferta exclusiva para você.';

    await sender.enviarTeste({
        telefone: '22999999999',
        mensagem: template,
        clienteExemplo: cliente,
    }, client);
    for (const tipo of ['promocao', 'cobranca']) {
        await sender.enviarMensagens([cliente], client, {
            tipo,
            mensagem: template,
            // Mantem a antiga opcao ativa de proposito: ela nao pode mais
            // acrescentar Cliente, Numero ou Valor fora do template.
            mostrarRodapeContato: true,
        }, { delay: false });
    }

    assert.deepEqual(enviados.map((envio) => envio.texto), [
        'Olá! Maria da Silva\nOferta exclusiva para você.',
        'Olá! Maria da Silva\nOferta exclusiva para você.',
        'Olá! Maria da Silva\nOferta exclusiva para você.',
    ]);
});

test('migra apenas o PIX fixo do template legado e preserva um backup', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-template-pix-'));
    const templatePath = path.join(temporaryDirectory, 'cobranca.txt');
    const previousDirectory = process.env.VALEVERDE_TEMPLATES_DIR;
    const legacyTemplate = [
        'Olá, {{nome}}!',
        '',
        'Texto personalizado mantido.',
        '',
        'Chave PIX: 22998628769',
        '',
        'Favorecido: Israel Felipe de Oliveira Donadio',
    ].join('\n');

    try {
        fs.writeFileSync(templatePath, legacyTemplate, 'utf8');
        process.env.VALEVERDE_TEMPLATES_DIR = temporaryDirectory;
        delete require.cache[require.resolve('../core/templates-store')];
        const isolatedStore = require('../core/templates-store');

        const [migrated] = isolatedStore.listTemplates();
        assert.match(migrated.texto, /Texto personalizado mantido/);
        assert.match(migrated.texto, /\{\{pix_tipo\}\}/);
        assert.match(migrated.texto, /\{\{pix_chave\}\}/);
        assert.match(migrated.texto, /\{\{pix_nome_favorecido\}\}/);
        assert.equal(fs.existsSync(`${templatePath}.pre-pix-placeholders.bak`), true);
        assert.equal(fs.readFileSync(`${templatePath}.pre-pix-placeholders.bak`, 'utf8'), legacyTemplate);
    } finally {
        if (previousDirectory === undefined) delete process.env.VALEVERDE_TEMPLATES_DIR;
        else process.env.VALEVERDE_TEMPLATES_DIR = previousDirectory;
        delete require.cache[require.resolve('../core/templates-store')];
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
});
