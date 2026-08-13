'use strict';

const {
    buildCustomerProfile,
    cleanText,
    normalizeCustomer,
    normalizePhoneDigits,
    onlyDigits,
} = require('./customer-utils');

const TAX_ID_TYPES = new Set([
    'cpf',
    'cnpj',
    'cpf_cnpj',
    'cpfcnpj',
    'tax_id',
    'taxid',
    'document',
    'documento',
]);

const PHONE_TYPES = new Set([
    'phone',
    'telefone',
    'telephone',
    'celular',
    'whatsapp',
]);

function text(value) {
    return String(value ?? '').trim();
}

function normalizeTaxId(value) {
    const digits = onlyDigits(value);
    return digits.length === 11 || digits.length === 14 ? digits : '';
}

function normalizeIdentifierType(value) {
    return text(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function addTaxKey(keys, value) {
    const normalized = normalizeTaxId(value);
    if (normalized) keys.add(`tax:${normalized}`);
}

function addPhoneKey(keys, value) {
    const normalized = normalizePhoneDigits(value);
    if (normalized) keys.add(`phone:${normalized}`);
}

function addTypedIdentifier(keys, identifier) {
    if (!identifier || typeof identifier !== 'object') return;
    const type = normalizeIdentifierType(identifier.type);
    const value = identifier.normalizedValue ?? identifier.normalized_value ?? identifier.value;
    if (TAX_ID_TYPES.has(type)) addTaxKey(keys, value);
    if (PHONE_TYPES.has(type)) addPhoneKey(keys, value);
}

function existingIdentityKeys(customer = {}) {
    const keys = new Set();
    [
        customer.cpf,
        customer.cnpj,
        customer.cpfCnpj,
        customer.cpf_cnpj,
        customer.taxId,
        customer.documento,
        customer.document,
    ].forEach((value) => addTaxKey(keys, value));
    [
        customer.telefone,
        customer.telefoneOriginal,
        customer.phone,
        customer.telephone,
        customer.celular,
        customer.whatsapp,
        customer.numero,
    ].forEach((value) => addPhoneKey(keys, value));
    (Array.isArray(customer.identifiers) ? customer.identifiers : []).forEach((identifier) => {
        addTypedIdentifier(keys, identifier);
    });
    return keys;
}

function profileIdentityKeys(profile = {}) {
    const keys = new Set();
    [
        profile.taxId,
        profile.cpf,
        profile.cnpj,
        profile.cpfCnpj,
        profile.document,
        profile.documento,
    ].forEach((value) => addTaxKey(keys, value));
    [
        profile.phone,
        profile.telephone,
        profile.telefone,
        profile.whatsapp,
    ].forEach((value) => addPhoneKey(keys, value));
    (Array.isArray(profile.identifiers) ? profile.identifiers : []).forEach((identifier) => {
        addTypedIdentifier(keys, identifier);
    });
    return keys;
}

function buildIndex(records, getKeys) {
    const index = new Map();
    records.forEach((record, position) => {
        for (const key of getKeys(record)) {
            if (!index.has(key)) index.set(key, new Set());
            index.get(key).add(position);
        }
    });
    return index;
}

function cloneJsonValue(value) {
    if (Array.isArray(value)) return value.map(cloneJsonValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]));
}

function publicConsumerProfile(profile) {
    const copy = cloneJsonValue(profile);
    for (const field of ['extra', 'raw', 'identifiers', 'taxId', 'cpf', 'cnpj', 'document', 'documento', 'phone', 'telephone', 'telefone', 'whatsapp', 'email']) {
        delete copy[field];
    }
    for (const order of Array.isArray(copy.ordersHistory) ? copy.ordersHistory : []) {
        for (const delivery of Array.isArray(order.deliveries) ? order.deliveries : []) {
            delete delivery.city;
            delete delivery.neighborhood;
        }
    }
    for (const entry of Array.isArray(copy.ledgerHistory) ? copy.ledgerHistory : []) {
        delete entry.description;
    }
    return copy;
}

function isActiveProfile(profile) {
    const value = profile?.active ?? profile?.ativo;
    if (value === undefined || value === null || value === '') return true;
    if (value === false || value === 0) return false;
    return !['false', '0', 'nao', 'não', 'inativo', 'inactive'].includes(text(value).toLowerCase());
}

function consumerCustomerId(profile) {
    const sourceKey = text(profile?.sourceKey);
    const externalId = text(profile?.externalId ?? profile?.id);
    return sourceKey && externalId ? `consumer:${sourceKey}:${externalId}` : '';
}

function firstTaxId(profile) {
    const direct = [
        profile.taxId,
        profile.cpf,
        profile.cnpj,
        profile.cpfCnpj,
        profile.document,
        profile.documento,
    ].map(normalizeTaxId).find(Boolean);
    if (direct) return direct;
    for (const identifier of Array.isArray(profile.identifiers) ? profile.identifiers : []) {
        if (TAX_ID_TYPES.has(normalizeIdentifierType(identifier?.type))) {
            const normalized = normalizeTaxId(identifier?.normalizedValue ?? identifier?.normalized_value ?? identifier?.value);
            if (normalized) return normalized;
        }
    }
    return '';
}

function firstPhone(profile) {
    const direct = [profile.phone, profile.telephone, profile.telefone, profile.whatsapp]
        .map(normalizePhoneDigits)
        .find(Boolean);
    if (direct) return direct;
    for (const identifier of Array.isArray(profile.identifiers) ? profile.identifiers : []) {
        if (PHONE_TYPES.has(normalizeIdentifierType(identifier?.type))) {
            const normalized = normalizePhoneDigits(identifier?.normalizedValue ?? identifier?.normalized_value ?? identifier?.value);
            if (normalized) return normalized;
        }
    }
    return '';
}

function finiteCents(value) {
    const cents = Number(value);
    return Number.isSafeInteger(cents) ? cents : 0;
}

function freshStatus(debt, phone) {
    if (debt > 0) return 'devedor';
    return phone ? 'em_dia' : 'sem_telefone';
}

function enrichCustomer(existing, profile) {
    const sourceKey = text(profile.sourceKey);
    const externalId = text(profile.externalId ?? profile.id);
    const profilePhone = firstPhone(profile);
    const phone = normalizePhoneDigits(
        existing.telefone || existing.telefoneOriginal || existing.phone || profilePhone,
    );
    const taxId = firstTaxId(profile);
    const debt = Math.max(0, finiteCents(profile.currentDebtCents)) / 100;
    const base = {
        ...existing,
        nome: cleanText(existing.nome || existing.name || profile.name || profile.nome || `Cliente Consumer ${externalId}`),
        cpf: existing.cpf || (taxId.length === 11 ? taxId : ''),
        cnpj: normalizeTaxId(existing.cnpj) || (taxId.length === 14 ? taxId : ''),
        documento: existing.documento || taxId,
        telefone: phone,
        telefoneOriginal: existing.telefoneOriginal || profile.phone || profilePhone || phone,
        email: existing.email || profile.email || '',
        valor: debt,
        valorDevido: debt,
        saldo_devedor: debt,
        status: freshStatus(debt, phone),
        ultimaCompra: profile.lastPurchaseAt || existing.ultimaCompra || '',
        consumerSourceKey: sourceKey,
        consumerExternalId: externalId,
        vinculoConsumer: { sourceKey, externalId },
        perfilConsumer: publicConsumerProfile(profile),
    };
    const normalized = normalizeCustomer(base, {
        keepRaw: false,
        source: existing.origem || '',
    }) || base;

    if (Object.prototype.hasOwnProperty.call(existing, 'id')) normalized.id = existing.id;
    normalized.cnpj = base.cnpj;
    normalized.documento = base.documento;
    normalized.email = base.email;
    normalized.consumerSourceKey = sourceKey;
    normalized.consumerExternalId = externalId;
    normalized.vinculoConsumer = base.vinculoConsumer;
    normalized.perfilConsumer = base.perfilConsumer;
    normalized.perfilAnalitico = buildCustomerProfile(normalized);
    delete normalized._temValorImportado;
    delete normalized._temStatusImportado;
    return normalized;
}

function createOperationalCustomer(profile) {
    const externalId = text(profile.externalId ?? profile.id);
    const taxId = firstTaxId(profile);
    const phone = firstPhone(profile);
    const id = consumerCustomerId(profile);
    return enrichCustomer({
        id,
        nome: cleanText(profile.name || profile.nome || `Cliente Consumer ${externalId}`),
        cpf: taxId.length === 11 ? taxId : '',
        cnpj: taxId.length === 14 ? taxId : '',
        documento: taxId,
        telefone: phone,
        telefoneOriginal: profile.phone || phone,
        email: profile.email || '',
        origem: 'backup_consumer',
    }, profile);
}

function combineConsumerCustomers(existingCustomers = [], consumerProfiles = []) {
    const existing = Array.isArray(existingCustomers) ? existingCustomers : [];
    const profiles = Array.isArray(consumerProfiles) ? consumerProfiles : [];
    const customers = existing.map((customer) => (
        customer && typeof customer === 'object' ? { ...customer } : customer
    ));
    const stats = {
        existing: existing.length,
        profiles: profiles.length,
        activeProfiles: 0,
        matched: 0,
        created: 0,
        pending: 0,
        pendingAmbiguous: 0,
        pendingInvalid: 0,
        inactiveSkipped: 0,
        totalCustomers: customers.length,
    };

    const activeRecords = [];
    profiles.forEach((profile, inputPosition) => {
        if (!profile || typeof profile !== 'object') {
            stats.pending += 1;
            stats.pendingInvalid += 1;
            return;
        }
        if (!isActiveProfile(profile)) {
            stats.inactiveSkipped += 1;
            return;
        }
        stats.activeProfiles += 1;
        const stableId = consumerCustomerId(profile);
        if (!stableId) {
            stats.pending += 1;
            stats.pendingInvalid += 1;
            return;
        }
        activeRecords.push({ profile, inputPosition, stableId, collision: false, candidate: null });
    });

    const existingObjects = existing.map((customer) => (
        customer && typeof customer === 'object' ? customer : {}
    ));
    const existingIndex = buildIndex(existingObjects, existingIdentityKeys);
    const profileIndex = buildIndex(activeRecords.map((record) => record.profile), profileIdentityKeys);
    const existingIdIndex = new Map();
    existingObjects.forEach((customer, position) => {
        const id = text(customer.id);
        if (!id) return;
        if (!existingIdIndex.has(id)) existingIdIndex.set(id, new Set());
        existingIdIndex.get(id).add(position);
    });
    const stableProfileIndex = new Map();
    activeRecords.forEach((record, position) => {
        if (!stableProfileIndex.has(record.stableId)) stableProfileIndex.set(record.stableId, new Set());
        stableProfileIndex.get(record.stableId).add(position);
    });

    activeRecords.forEach((record, recordPosition) => {
        const keys = profileIdentityKeys(record.profile);
        const candidates = new Set();
        if ((stableProfileIndex.get(record.stableId)?.size || 0) > 1) record.collision = true;

        for (const key of keys) {
            const sameProfiles = profileIndex.get(key);
            const sameExisting = existingIndex.get(key);
            if ((sameProfiles?.size || 0) > 1 || (sameExisting?.size || 0) > 1) {
                record.collision = true;
            }
            if (sameExisting?.size === 1) candidates.add([...sameExisting][0]);
        }

        const linkedById = existingIdIndex.get(record.stableId);
        if ((linkedById?.size || 0) > 1) record.collision = true;
        if (linkedById?.size === 1) candidates.add([...linkedById][0]);
        if (candidates.size > 1) record.collision = true;
        if (candidates.size === 1) record.candidate = [...candidates][0];

        // Keep the position available for the reciprocal-claim pass below.
        record.recordPosition = recordPosition;
    });

    const claims = new Map();
    activeRecords.forEach((record) => {
        if (record.collision || record.candidate === null) return;
        if (!claims.has(record.candidate)) claims.set(record.candidate, []);
        claims.get(record.candidate).push(record.recordPosition);
    });
    for (const recordPositions of claims.values()) {
        if (recordPositions.length < 2) continue;
        recordPositions.forEach((position) => {
            activeRecords[position].collision = true;
        });
    }

    activeRecords.forEach((record) => {
        if (record.collision) {
            stats.pending += 1;
            stats.pendingAmbiguous += 1;
            return;
        }
        if (record.candidate !== null) {
            customers[record.candidate] = enrichCustomer(existingObjects[record.candidate], record.profile);
            stats.matched += 1;
            return;
        }
        customers.push(createOperationalCustomer(record.profile));
        stats.created += 1;
    });

    stats.totalCustomers = customers.length;
    return { customers, stats };
}

function consumerStoreMethod(store, method) {
    if (!store || typeof store[method] !== 'function') {
        throw new TypeError(`Um ConsumerStore com ${method}() e obrigatorio.`);
    }
    return store[method].bind(store);
}

function listCustomerHistoryProfiles(store, options = {}) {
    const normalized = typeof options === 'string' ? { sourceKey: options } : (options || {});
    return consumerStoreMethod(store, 'listCustomerProfiles')({
        ...normalized,
        // Operational customer composition intentionally receives summaries unless
        // a caller explicitly opts into the potentially large fact history.
        includeHistory: normalized.includeHistory === true,
    });
}

function getCustomerProfile(store, sourceKeyOrOptions, externalId) {
    return consumerStoreMethod(store, 'getCustomerProfile')(sourceKeyOrOptions, externalId);
}

module.exports = {
    combineConsumerCustomers,
    consumerCustomerId,
    getCustomerProfile,
    listCustomerHistoryProfiles,
    normalizeTaxId,
    publicConsumerProfile,
};
