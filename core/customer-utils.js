const validator = require('./validator');

const DEBTOR_THRESHOLD = 50;

function cleanText(value) {
    return String(value ?? '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function removeAccents(value) {
    return cleanText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function slugify(value) {
    return removeAccents(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

function onlyDigits(value) {
    return String(value ?? '').replace(/\D/g, '');
}

function normalizeCpf(value) {
    const digits = onlyDigits(value);
    return digits.length === 11 ? digits : '';
}

function normalizePhoneDigits(value) {
    let digits = onlyDigits(value);
    if (!digits) return '';
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    if (digits.length > 13 && digits.startsWith('55')) digits = `55${digits.slice(-11)}`;
    if (digits.length > 13) digits = `55${digits.slice(-11)}`;
    return digits.length >= 12 && digits.length <= 13 ? digits : '';
}

function toWhatsappId(value) {
    const digits = normalizePhoneDigits(value);
    return digits ? validator.formatarNumero(digits) : null;
}

function parseMoney(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    let text = cleanText(value).replace(/[R$\s]/g, '');
    if (!text) return null;

    const hasComma = text.includes(',');
    const hasDot = text.includes('.');

    if (hasComma && hasDot) {
        text = text.replace(/\./g, '').replace(',', '.');
    } else if (hasComma) {
        text = text.replace(',', '.');
    } else if ((text.match(/\./g) || []).length > 1) {
        const lastDot = text.lastIndexOf('.');
        text = text.slice(0, lastDot).replace(/\./g, '') + text.slice(lastDot);
    }

    text = text.replace(/[^\d.-]/g, '');
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
    });
}

function normalizedHeader(value) {
    return removeAccents(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findKey(row, candidates) {
    const keys = Object.keys(row || {});
    return keys.find((key) => candidates.some((candidate) => normalizedHeader(key).includes(candidate)));
}

function getField(row, names) {
    for (const name of names) {
        if (row && row[name] !== undefined && row[name] !== null && row[name] !== '') {
            return row[name];
        }
    }
    const key = findKey(row, names.map(normalizedHeader));
    return key ? row[key] : undefined;
}

function findPhoneInText(value) {
    const text = cleanText(value);
    const match = text.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\d{4}[-\s]?\d{4}|\d{4}[-\s]?\d{4}|\d{11})/);
    return match ? match[0] : '';
}

function splitNamePhone(value) {
    const text = cleanText(value);
    const phone = findPhoneInText(text);
    if (!phone) return { name: text, phone: '' };
    return {
        name: cleanText(text.replace(phone, '')),
        phone,
    };
}

function statusFrom(value, amount, hasPhone) {
    const text = removeAccents(value).toLowerCase();
    if (/^(devedor|devendo|atrasado|inadimplente|pendente|em aberto|aberto|vencido|nao pago)$/.test(text)) {
        return 'devedor';
    }
    if (/^(em dia|regular|quitado|pago|adimplente)$/.test(text)) {
        return 'em_dia';
    }
    if (/^(sem telefone|sem tel|sem contato|s telefone|s tel)$/.test(text)) {
        return 'sem_telefone';
    }
    if (Number(amount || 0) > 0) return 'devedor';
    return hasPhone ? 'em_dia' : 'sem_telefone';
}

function isDebtor(customer) {
    const status = removeAccents(customer?.status).toLowerCase();
    const amount = getDebtAmount(customer);
    return status === 'devedor' || /inadimplente|pendente|aberto|vencido|nao pago/.test(status) || amount > 0;
}

function getDebtAmount(customer) {
    const amount = customer?.saldo_devedor ?? customer?.valorDevido ?? customer?.valor ?? customer?.saldo;
    const parsed = typeof amount === 'number' ? amount : parseMoney(amount);
    return Number(parsed || 0);
}

function buildCustomerProfile(customer = {}) {
    const debt = getDebtAmount(customer);
    const hasPhone = Boolean(normalizePhoneDigits(customer.telefone || customer.telefoneOriginal));
    if (debt >= 500) {
        return { nivel: 'critico', rotulo: 'Cobranca prioritaria', elegivelCobranca: hasPhone, motivo: 'Saldo alto em aberto' };
    }
    if (debt >= DEBTOR_THRESHOLD) {
        return { nivel: 'atencao', rotulo: 'Cobranca elegivel', elegivelCobranca: hasPhone, motivo: hasPhone ? 'Saldo acima do limite de cobranca' : 'Saldo acima do limite sem telefone valido' };
    }
    if (debt > 0) {
        return { nivel: 'acompanhamento', rotulo: 'Acompanhar saldo', elegivelCobranca: false, motivo: 'Saldo abaixo do limite de R$ 50,00' };
    }
    if (!hasPhone) {
        return { nivel: 'contato', rotulo: 'Atualizar contato', elegivelCobranca: false, motivo: 'Telefone ausente ou invalido' };
    }
    return { nivel: 'regular', rotulo: 'Cliente regular', elegivelCobranca: false, motivo: 'Sem saldo devedor atual' };
}

function getPhoneFromAnyField(row, preferredPhone) {
    if (preferredPhone) return preferredPhone;
    for (const value of Object.values(row || {})) {
        const found = findPhoneInText(value);
        if (found) return found;
    }
    return '';
}

function normalizeCustomer(input = {}, options = {}) {
    const row = input.linhaRaw && typeof input.linhaRaw === 'object' ? input.linhaRaw : input;

    const rawName = getField(row, ['nome', 'cliente', 'nomecliente', 'name']) ?? '';
    const rawCpf = getField(row, ['cpf', 'documento', 'doc']) ?? input.cpf ?? '';
    const rawPhoneField = getField(row, ['telefone', 'tel', 'celular', 'whatsapp', 'contato', 'numero']) ?? input.telefone ?? input.telefoneOriginal ?? '';
    const rawPhone = getPhoneFromAnyField(row, rawPhoneField);
    const parsedName = splitNamePhone(rawName);

    const amountCandidates = ['valorDevido', 'saldo_devedor', 'saldoDevedor', 'valor', 'saldo', 'divida', 'devido', 'debito'];
    const rawAmount = getField(row, amountCandidates);
    const hasImportedAmount = rawAmount !== undefined && rawAmount !== null && cleanText(rawAmount) !== '';
    const parsedAmount = parseMoney(rawAmount);
    const amount = hasImportedAmount ? Number(parsedAmount || 0) : Number(input.valorDevido ?? input.saldo_devedor ?? input.valor ?? 0);

    const rawStatus = getField(row, ['status', 'situacao', 'situação', 'estado']) ?? input.status ?? '';
    const phoneDigits = normalizePhoneDigits(rawPhone || parsedName.phone || input.telefone);
    const name = cleanText(input.nome || parsedName.name || rawName);
    const cpf = normalizeCpf(rawCpf || input.cpf);
    const identity = getPrimaryIdentity({ cpf, telefone: phoneDigits, nome: name });

    if (!identity) return null;

    const now = options.now || new Date().toISOString();
    const status = rawStatus
        ? statusFrom(rawStatus, amount, Boolean(phoneDigits))
        : (hasImportedAmount ? statusFrom('', amount, Boolean(phoneDigits)) : (input.status || statusFrom('', amount, Boolean(phoneDigits))));

    return {
        ...input,
        id: input.id || `cliente-${identity.replace(':', '-')}`,
        chaveCliente: identity,
        nome: name,
        cpf,
        telefone: phoneDigits,
        telefoneOriginal: cleanText(rawPhone || input.telefoneOriginal || phoneDigits),
        telefoneValido: phoneDigits ? toWhatsappId(phoneDigits) : null,
        valor: amount,
        valorDevido: amount,
        saldo_devedor: amount,
        status,
        perfilAnalitico: buildCustomerProfile({ saldo_devedor: amount, status, telefone: phoneDigits, telefoneOriginal: rawPhone }),
        ultimaCompra: cleanText(getField(row, ['ultimaCompra', 'ultima_compra', 'data', 'dataCompra', 'compra']) ?? input.ultimaCompra ?? ''),
        origem: options.source || input.origem || '',
        atualizadoEm: now,
        criadoEm: input.criadoEm || now,
        linhaRaw: options.keepRaw === false ? undefined : row,
        _temValorImportado: hasImportedAmount,
        _temStatusImportado: Boolean(rawStatus),
    };
}

function getIdentityKeys(customer = {}) {
    const keys = [];
    const cpf = normalizeCpf(customer.cpf);
    const phone = normalizePhoneDigits(customer.telefone || customer.telefoneOriginal || customer.numero);
    const name = slugify(customer.nome);
    if (cpf) keys.push(`cpf:${cpf}`);
    if (phone) keys.push(`tel:${phone}`);
    if (name) keys.push(`nome:${name}`);
    return keys;
}

function getPrimaryIdentity(customer = {}) {
    return getIdentityKeys(customer)[0] || '';
}

function mergeCustomer(existing, incoming) {
    const merged = { ...existing };
    const overwrite = (field, value) => {
        if (value !== undefined && value !== null && value !== '') merged[field] = value;
    };

    overwrite('nome', incoming.nome);
    overwrite('cpf', incoming.cpf);
    overwrite('telefone', incoming.telefone);
    overwrite('telefoneOriginal', incoming.telefoneOriginal);
    overwrite('telefoneValido', incoming.telefoneValido);
    overwrite('ultimaCompra', incoming.ultimaCompra);
    overwrite('origem', incoming.origem);

    if (incoming._temValorImportado || existing.valorDevido === undefined) {
        merged.valor = Number(incoming.valorDevido || 0);
        merged.valorDevido = Number(incoming.valorDevido || 0);
        merged.saldo_devedor = Number(incoming.valorDevido || 0);
    }

    if (incoming._temStatusImportado || incoming._temValorImportado || !existing.status) {
        merged.status = incoming.status;
    }

    merged.chaveCliente = getPrimaryIdentity(merged);
    merged.atualizadoEm = incoming.atualizadoEm;
    merged.criadoEm = existing.criadoEm || incoming.criadoEm;
    merged.linhaRaw = incoming.linhaRaw;
    delete merged._temValorImportado;
    delete merged._temStatusImportado;
    return merged;
}

function upsertCustomers(existingCustomers = [], incomingRows = [], options = {}) {
    const customers = [];
    const index = new Map();
    const now = options.now || new Date().toISOString();
    let created = 0;
    let updated = 0;
    let ignored = 0;

    const register = (customer, position) => {
        getIdentityKeys(customer).forEach((key) => index.set(key, position));
    };

    existingCustomers.forEach((customer) => {
        const normalized = normalizeCustomer(customer, { now, keepRaw: false }) || customer;
        normalized.id = customer.id || normalized.id;
        normalized.criadoEm = customer.criadoEm || normalized.criadoEm || now;
        delete normalized._temValorImportado;
        delete normalized._temStatusImportado;
        customers.push(normalized);
        register(normalized, customers.length - 1);
    });

    incomingRows.forEach((row) => {
        const incoming = normalizeCustomer(row, { ...options, now });
        if (!incoming) {
            ignored += 1;
            return;
        }

        const matchKey = getIdentityKeys(incoming).find((key) => index.has(key));
        if (matchKey) {
            const position = index.get(matchKey);
            customers[position] = mergeCustomer(customers[position], incoming);
            register(customers[position], position);
            updated += 1;
            return;
        }

        delete incoming._temValorImportado;
        delete incoming._temStatusImportado;
        customers.push(incoming);
        register(incoming, customers.length - 1);
        created += 1;
    });

    customers.sort((a, b) => cleanText(a.nome || a.telefone).localeCompare(cleanText(b.nome || b.telefone), 'pt-BR'));

    return { customers, created, updated, ignored, total: incomingRows.length };
}

function filterDebtorsThreshold(customers = [], threshold = DEBTOR_THRESHOLD) {
    return customers.filter((customer) => {
        const phone = normalizePhoneDigits(customer.telefone || customer.telefoneOriginal);
        return phone && isDebtor(customer) && getDebtAmount(customer) >= threshold;
    });
}

function filterCustomersWithPhone(customers = []) {
    return customers.filter((customer) => normalizePhoneDigits(customer.telefone || customer.telefoneOriginal));
}

function buildAnalytics(customers = []) {
    const normalized = customers.map((customer) => normalizeCustomer(customer, { keepRaw: false })).filter(Boolean);
    const debtors = normalized.filter(isDebtor);
    const debtorsAboveThreshold = filterDebtorsThreshold(normalized);
    const totalDebt = debtors.reduce((sum, customer) => sum + getDebtAmount(customer), 0);
    const customersWithPhone = filterCustomersWithPhone(normalized);

    return {
        generatedAt: new Date().toISOString(),
        store: {
            totalCustomers: normalized.length,
            customersWithPhone: customersWithPhone.length,
            debtors: debtors.length,
            debtorsAboveThreshold: debtorsAboveThreshold.length,
            totalDebt,
            averageDebt: debtors.length ? totalDebt / debtors.length : 0,
            delinquencyRate: normalized.length ? debtors.length / normalized.length : 0,
        },
        debtors: debtors
            .map((customer) => ({
                id: customer.id,
                nome: customer.nome,
                telefone: customer.telefone,
                saldo_devedor: getDebtAmount(customer),
                status: customer.status,
                ultimaCompra: customer.ultimaCompra || '',
                perfilAnalitico: buildCustomerProfile(customer),
            }))
            .sort((a, b) => b.saldo_devedor - a.saldo_devedor),
        customers: normalized.map((customer) => ({
            id: customer.id,
            nome: customer.nome,
            telefone: customer.telefone,
            cpf: customer.cpf,
            saldo_devedor: getDebtAmount(customer),
            status: customer.status,
            perfilAnalitico: buildCustomerProfile(customer),
        })),
    };
}

module.exports = {
    DEBTOR_THRESHOLD,
    cleanText,
    slugify,
    onlyDigits,
    normalizeCpf,
    normalizePhoneDigits,
    toWhatsappId,
    parseMoney,
    formatMoney,
    normalizeCustomer,
    upsertCustomers,
    getDebtAmount,
    buildCustomerProfile,
    isDebtor,
    filterDebtorsThreshold,
    filterCustomersWithPhone,
    buildAnalytics,
};
