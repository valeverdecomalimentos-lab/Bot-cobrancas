const { getTemplateByFile } = require('./templates-store');
const { cleanText, formatMoney, getDebtAmount } = require('./customer-utils');
const defaults = require('../config');
const {
    hasPixPlaceholders,
    normalizePixSettings,
    pixTypeLabel,
    validatePixSettings,
} = require('./pix');

function resolveTemplate(templateFile) {
    const template = getTemplateByFile(templateFile || 'cobranca.txt');
    if (!template) {
        throw new Error(`Template nao encontrado: ${templateFile || 'cobranca.txt'}`);
    }
    return template;
}

function firstName(name) {
    return cleanText(name).split(/\s+/).filter(Boolean)[0] || '';
}

function resolveFormatOptions(mostrarRodapeContato, pixSettings) {
    if (mostrarRodapeContato && typeof mostrarRodapeContato === 'object' && !Array.isArray(mostrarRodapeContato)) {
        const options = mostrarRodapeContato;
        return {
            pixSettings: options.pixSettings || options.pix || options,
        };
    }
    return {
        pixSettings,
    };
}

function resolvePixSettings(pixSettings) {
    return normalizePixSettings(pixSettings, defaults.pix || defaults);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacePixPlaceholders(templateText, pixSettings) {
    let text = String(templateText || '');
    if (!hasPixPlaceholders(text)) return text;

    const pix = resolvePixSettings(pixSettings);
    const validation = validatePixSettings(pix);
    if (!validation.valid) {
        throw new Error(`Dados PIX incompletos ou invalidos. ${validation.message}`);
    }

    const replacements = {
        '{{pix_nome_favorecido}}': pix.nomeFavorecido,
        '{{pix_favorecido}}': pix.nomeFavorecido,
        '{{nome_favorecido}}': pix.nomeFavorecido,
        '{{nome_favorecido_pix}}': pix.nomeFavorecido,
        '{{favorecido_pix}}': pix.nomeFavorecido,
        '{{pix_chave}}': pix.chave,
        '{{chave_pix}}': pix.chave,
        '{{pix_tipo}}': pixTypeLabel(pix.tipo),
        '{{tipo_chave_pix}}': pixTypeLabel(pix.tipo),
    };
    Object.entries(replacements).forEach(([placeholder, value]) => {
        text = text.replace(new RegExp(escapeRegExp(placeholder), 'gi'), () => value);
    });
    return text;
}

function formatMessage(cliente, templateText, mostrarRodapeContato = true, pixSettings) {
    const options = resolveFormatOptions(mostrarRodapeContato, pixSettings);
    const template = String(templateText || '').trim();
    if (!template) throw new Error('Mensagem/template vazio.');

    const nome = cleanText(cliente.nome);
    const numero = cleanText(cliente.numero || cliente.telefoneOriginal || cliente.telefone || '');
    const valor = formatMoney(getDebtAmount(cliente)).replace(/^R\$\s?/, '');

    const mensagem = replacePixPlaceholders(template, options.pixSettings)
        .replace(/\{\{nome\}\}/g, nome)
        .replace(/\{\{primeiro_nome\}\}/g, firstName(nome))
        .replace(/\[cliente\]/g, nome)
        .replace(/\{\{valor\}\}/g, valor)
        .replace(/\{\{saldo_devedor\}\}/g, valor)
        .replace(/\{\{numero\}\}/g, numero || 'nao informado')
        .replace(/\{\{telefone\}\}/g, numero || 'nao informado')
        .replace(/\{\{cpf\}\}/g, cleanText(cliente.cpf || 'nao informado'))
        .replace(/\[0,00\]/g, valor);

    // O corpo enviado pertence ao usuario. O sistema somente resolve os
    // placeholders presentes e nunca acrescenta aviso, cabecalho ou rodape.
    // `mostrarRodapeContato` permanece na assinatura para compatibilidade com
    // scripts antigos, mas nao altera mais a mensagem.
    return mensagem.trim();
}

module.exports = {
    montar: (cliente, templateFile = 'cobranca.txt', mostrarRodapeContato = true, pixSettings) => (
        formatMessage(cliente, resolveTemplate(templateFile), mostrarRodapeContato, pixSettings)
    ),
    montarComTexto: formatMessage,
    resolverPix: resolvePixSettings,
    substituirPlaceholdersPix: replacePixPlaceholders,
};
