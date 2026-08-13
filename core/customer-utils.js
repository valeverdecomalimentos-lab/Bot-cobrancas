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

function normalizeCnpj(value) {
    const digits = onlyDigits(value);
    return digits.length === 14 ? digits : '';
}

function normalizeTaxId(value) {
    return normalizeCpf(value) || normalizeCnpj(value);
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
    for (const [key, value] of Object.entries(row || {})) {
        const header = normalizedHeader(key);
        if (header === 'doc' || /cpf|cnpj|documento|taxid/.test(header)) continue;
        const found = findPhoneInText(value);
        if (found) return found;
    }
    return '';
}

function normalizeCustomer(input = {}, options = {}) {
    const row = input.linhaRaw && typeof input.linhaRaw === 'object' ? input.linhaRaw : input;

    const rawName = getField(row, ['nome', 'cliente', 'nomecliente', 'name']) ?? '';
    const rawTaxId = getField(row, ['cpf', 'cnpj', 'documento', 'document', 'taxId', 'tax_id', 'doc']) ?? input.cpf ?? input.cnpj ?? '';
    const taxId = normalizeTaxId(rawTaxId || input.cpf || input.cnpj);
    const phoneCandidate = getField(row, ['telefone', 'tel', 'celular', 'whatsapp', 'contato', 'numero']) ?? input.telefone ?? input.telefoneOriginal ?? '';
    const rawPhoneField = taxId && onlyDigits(phoneCandidate) === taxId ? '' : phoneCandidate;
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
    const cpf = taxId.length === 11 ? taxId : '';
    const cnpj = taxId.length === 14 ? taxId : '';
    const identity = getPrimaryIdentity({ cpf, cnpj, telefone: phoneDigits, nome: name });

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
        cnpj,
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

function getDocumentIdentityKeys(customer = {}) {
    const keys = [];
    const documents = [customer.cpf, customer.cnpj, customer.documento, customer.document, customer.taxId, customer.tax_id, customer.doc]
        .map(normalizeTaxId)
        .filter((document, position, values) => document && values.indexOf(document) === position);

    documents.forEach((document) => {
        keys.push(`${document.length === 11 ? 'cpf' : 'cnpj'}:${document}`);
    });
    return keys;
}

function getStrongIdentityKeys(customer = {}) {
    const keys = getDocumentIdentityKeys(customer);
    const phone = normalizePhoneDigits(customer.telefone || customer.telefoneOriginal || customer.numero);
    if (phone) keys.push(`tel:${phone}`);
    return keys;
}

function getNameIdentityKey(customer = {}) {
    const name = slugify(customer.nome);
    return name ? `nome:${name}` : '';
}

function getIdentityKeys(customer = {}) {
    const nameKey = getNameIdentityKey(customer);
    return [...getStrongIdentityKeys(customer), ...(nameKey ? [nameKey] : [])];
}

function getPrimaryIdentity(customer = {}) {
    return getIdentityKeys(customer)[0] || '';
}

function hasStrongIdentityConflict(existing = {}, incoming = {}) {
    const existingDocuments = getDocumentIdentityKeys(existing);
    const incomingDocuments = getDocumentIdentityKeys(incoming);
    const documentsConflict = existingDocuments.length > 0
        && incomingDocuments.length > 0
        && !incomingDocuments.some((key) => existingDocuments.includes(key));
    const existingPhone = normalizePhoneDigits(existing.telefone || existing.telefoneOriginal || existing.numero);
    const incomingPhone = normalizePhoneDigits(incoming.telefone || incoming.telefoneOriginal || incoming.numero);
    const phonesConflict = Boolean(existingPhone && incomingPhone && existingPhone !== incomingPhone);
    return documentsConflict || phonesConflict;
}

function mergeCustomer(existing, incoming) {
    const merged = { ...existing };
    const overwrite = (field, value) => {
        if (value !== undefined && value !== null && value !== '') merged[field] = value;
    };

    overwrite('nome', incoming.nome);
    overwrite('cpf', incoming.cpf);
    overwrite('cnpj', incoming.cnpj);
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
    const strongIndex = new Map();
    const nameIndex = new Map();
    const now = options.now || new Date().toISOString();
    let created = 0;
    let updated = 0;
    let ignored = 0;

    const addToIndex = (index, key, position) => {
        if (!key) return;
        const positions = index.get(key) || new Set();
        positions.add(position);
        index.set(key, positions);
    };

    const removeFromIndex = (index, key, position) => {
        if (!key) return;
        const positions = index.get(key);
        if (!positions) return;
        positions.delete(position);
        if (positions.size === 0) index.delete(key);
    };

    const register = (customer, position) => {
        getStrongIdentityKeys(customer).forEach((key) => addToIndex(strongIndex, key, position));
        addToIndex(nameIndex, getNameIdentityKey(customer), position);
    };

    const unregister = (customer, position) => {
        getStrongIdentityKeys(customer).forEach((key) => removeFromIndex(strongIndex, key, position));
        removeFromIndex(nameIndex, getNameIdentityKey(customer), position);
    };

    const updateAt = (position, incoming) => {
        unregister(customers[position], position);
        customers[position] = mergeCustomer(customers[position], incoming);
        register(customers[position], position);
        updated += 1;
    };

    const create = (incoming) => {
        delete incoming._temValorImportado;
        delete incoming._temStatusImportado;
        customers.push(incoming);
        register(incoming, customers.length - 1);
        created += 1;
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

        const strongKeys = getStrongIdentityKeys(incoming);
        if (strongKeys.length > 0) {
            const matchingPositions = new Set();
            strongKeys.forEach((key) => {
                strongIndex.get(key)?.forEach((position) => matchingPositions.add(position));
            });

            if (matchingPositions.size === 1) {
                const [position] = matchingPositions;
                if (hasStrongIdentityConflict(customers[position], incoming)) {
                    ignored += 1;
                    return;
                }
                updateAt(position, incoming);
                return;
            }

            if (matchingPositions.size > 1) {
                ignored += 1;
                return;
            }

            create(incoming);
            return;
        }

        const namePositions = nameIndex.get(getNameIdentityKey(incoming));
        if (namePositions?.size === 1) {
            const [position] = namePositions;
            updateAt(position, incoming);
            return;
        }

        if (namePositions?.size > 1) {
            ignored += 1;
            return;
        }

        create(incoming);
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
