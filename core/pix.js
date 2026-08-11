const PIX_TYPES = Object.freeze({
    cpf: 'CPF',
    cnpj: 'CNPJ',
    email: 'E-mail',
    telefone: 'Telefone',
    aleatoria: 'Chave aleatoria',
});

const PIX_PLACEHOLDERS = Object.freeze([
    '{{pix_nome_favorecido}}',
    '{{pix_favorecido}}',
    '{{nome_favorecido}}',
    '{{nome_favorecido_pix}}',
    '{{favorecido_pix}}',
    '{{pix_chave}}',
    '{{chave_pix}}',
    '{{pix_tipo}}',
    '{{tipo_chave_pix}}',
]);

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
}

function normalizeText(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function onlyDigits(value) {
    return String(value ?? '').replace(/\D/g, '');
}

function hasRepeatedDigits(value) {
    return /^(\d)\1+$/.test(value);
}

function isValidCpf(value) {
    const digits = onlyDigits(value);
    if (digits.length !== 11 || hasRepeatedDigits(digits)) return false;

    const calculateDigit = (length) => {
        let total = 0;
        for (let index = 0; index < length; index += 1) {
            total += Number(digits[index]) * (length + 1 - index);
        }
        const remainder = (total * 10) % 11;
        return remainder === 10 ? 0 : remainder;
    };

    return calculateDigit(9) === Number(digits[9]) && calculateDigit(10) === Number(digits[10]);
}

function isValidCnpj(value) {
    const digits = onlyDigits(value);
    if (digits.length !== 14 || hasRepeatedDigits(digits)) return false;

    const calculateDigit = (length) => {
        const weights = length === 12
            ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
            : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        const total = weights.reduce((sum, weight, index) => sum + Number(digits[index]) * weight, 0);
        const remainder = total % 11;
        return remainder < 2 ? 0 : 11 - remainder;
    };

    return calculateDigit(12) === Number(digits[12]) && calculateDigit(13) === Number(digits[13]);
}

function inferPixType(key) {
    const value = normalizeText(key);
    if (!value) return 'aleatoria';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value)) return 'email';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return 'aleatoria';

    const digits = onlyDigits(value);
    if (isValidCpf(digits)) return 'cpf';
    if (isValidCnpj(digits)) return 'cnpj';
    if (digits.length >= 10 && digits.length <= 13) return 'telefone';
    return 'aleatoria';
}

function normalizePixType(value, key = '') {
    const normalized = normalizeText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const aliases = {
        cpf: 'cpf',
        cnpj: 'cnpj',
        email: 'email',
        'e-mail': 'email',
        telefone: 'telefone',
        celular: 'telefone',
        phone: 'telefone',
        aleatoria: 'aleatoria',
        aleatorio: 'aleatoria',
        random: 'aleatoria',
        evp: 'aleatoria',
    };
    return aliases[normalized] || inferPixType(key);
}

function readPixValues(input = {}) {
    const source = isRecord(input) ? input : {};
    const nested = isRecord(source.pix) ? source.pix : {};
    return {
        nomeFavorecido: firstDefined(
            nested.nomeFavorecido,
            nested.nome,
            nested.favorecido,
            source.nomeFavorecido,
            source.nomeFavorecidoPix,
            source.pixNomeFavorecido,
            source.PIX_NOME_FAVORECIDO,
        ),
        chave: firstDefined(
            nested.chave,
            nested.key,
            source.chave,
            source.chavePix,
            source.pixChave,
            source.PIX,
        ),
        tipo: firstDefined(
            nested.tipo,
            nested.tipoChave,
            source.tipo,
            source.tipoChavePix,
            source.pixTipo,
            source.PIX_TIPO,
        ),
    };
}

function normalizePixSettings(input = {}, fallback = {}) {
    const current = readPixValues(input);
    const defaults = readPixValues(fallback);
    const nomeFavorecido = normalizeText(firstDefined(current.nomeFavorecido, defaults.nomeFavorecido, ''));
    const chave = normalizeText(firstDefined(current.chave, defaults.chave, ''));
    // Uma chave legada salva sem tipo deve ser inferida a partir dela propria,
    // e nao herdar por engano o tipo da chave padrao da aplicacao.
    const tipoValue = current.tipo !== undefined
        ? current.tipo
        : (current.chave !== undefined ? undefined : defaults.tipo);
    const tipo = normalizePixType(tipoValue, chave);

    return { nomeFavorecido, chave, tipo };
}

function validatePixSettings(input = {}, options = {}) {
    const pix = normalizePixSettings(input);
    const allowEmpty = options.allowEmpty === true;
    const errors = {};

    if (allowEmpty && !pix.nomeFavorecido && !pix.chave) {
        return { valid: true, pix, errors, message: '' };
    }

    if (!pix.nomeFavorecido) {
        errors.nomeFavorecido = 'Informe o nome do favorecido que aparece na conta PIX.';
    } else if (pix.nomeFavorecido.length < 3) {
        errors.nomeFavorecido = 'O nome do favorecido precisa ter pelo menos 3 caracteres.';
    } else if (pix.nomeFavorecido.length > 120) {
        errors.nomeFavorecido = 'O nome do favorecido deve ter no maximo 120 caracteres.';
    }

    if (!pix.chave) {
        errors.chave = 'Informe a chave PIX.';
    } else if (pix.chave.length > 140) {
        errors.chave = 'A chave PIX deve ter no maximo 140 caracteres.';
    } else if (pix.tipo === 'cpf' && !/^[\d.\s-]+$/.test(pix.chave)) {
        errors.chave = 'Use apenas numeros e pontuacao de CPF na chave PIX.';
    } else if (pix.tipo === 'cpf' && !isValidCpf(pix.chave)) {
        errors.chave = 'Informe um CPF valido com 11 digitos.';
    } else if (pix.tipo === 'cnpj' && !/^[\d./\s-]+$/.test(pix.chave)) {
        errors.chave = 'Use apenas numeros e pontuacao de CNPJ na chave PIX.';
    } else if (pix.tipo === 'cnpj' && !isValidCnpj(pix.chave)) {
        errors.chave = 'Informe um CNPJ valido com 14 digitos.';
    } else if (pix.tipo === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(pix.chave)) {
        errors.chave = 'Informe um e-mail valido para a chave PIX.';
    } else if (pix.tipo === 'telefone' && !/^\+?[\d\s().-]+$/.test(pix.chave)) {
        errors.chave = 'Use apenas o codigo do pais, DDD e numero na chave de telefone.';
    } else if (pix.tipo === 'telefone' && (onlyDigits(pix.chave).length < 10 || onlyDigits(pix.chave).length > 13)) {
        errors.chave = 'Informe um telefone PIX valido, com DDD e, se houver, codigo do pais.';
    } else if (pix.tipo === 'aleatoria' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pix.chave)) {
        errors.chave = 'Informe uma chave aleatoria PIX valida no formato UUID.';
    }

    const messages = [...new Set(Object.values(errors))];
    return {
        valid: messages.length === 0,
        pix,
        errors,
        message: messages.join(' '),
    };
}

function pixTypeLabel(type) {
    return PIX_TYPES[normalizePixType(type)] || PIX_TYPES.aleatoria;
}

function hasPixPlaceholders(templateText) {
    const template = String(templateText || '').toLowerCase();
    return PIX_PLACEHOLDERS.some((placeholder) => template.includes(placeholder));
}

function pixSettingsWithLegacyAliases(input = {}, fallback = {}) {
    const pix = normalizePixSettings(input, fallback);
    return {
        pix,
        nomeFavorecido: pix.nomeFavorecido,
        chavePix: pix.chave,
        tipoChavePix: pix.tipo,
    };
}

module.exports = {
    PIX_PLACEHOLDERS,
    PIX_TYPES,
    hasPixPlaceholders,
    inferPixType,
    isValidCnpj,
    isValidCpf,
    normalizePixSettings,
    normalizePixType,
    pixSettingsWithLegacyAliases,
    pixTypeLabel,
    validatePixSettings,
};
