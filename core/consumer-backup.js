'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { normalizePhoneDigits } = require('./customer-utils');
const { extractConsumerBackup, ENTITY_DEFINITIONS } = require('./consumer-extractor');
const { createConsumerStore } = require('./consumer-store');
const {
    MAX_BACKUP_BYTES,
    downloadGoogleDriveBackup,
    extractGoogleDriveFileId,
} = require('./google-drive-download');

const DEFAULT_SOURCE_KEY = 'consumer:principal';
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
const LOCAL_OFFSET = '-03:00';
const SUPPORTED_BACKUP_EXTENSIONS = new Set(['.fbconsumer', '.fb', '.fbk', '.gbk', '.bak', '.backup']);

class ConsumerImportError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'ConsumerImportError';
        this.code = code;
        if (options.stage) this.stage = options.stage;
    }
}

function cleanText(value) {
    return String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function optionalText(value) {
    return cleanText(value) || null;
}

function external(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
}

function cents(value) {
    if (value === null || value === undefined || value === '') return 0;
    const amount = Number(value);
    if (!Number.isFinite(amount)) throw new ConsumerImportError('INVALID_MONEY', 'O backup contém um valor financeiro inválido.', { stage: 'transform' });
    const result = Math.round((amount + Number.EPSILON) * 100);
    if (!Number.isSafeInteger(result)) throw new ConsumerImportError('MONEY_OUT_OF_RANGE', 'Um valor financeiro do backup excede o limite seguro.', { stage: 'transform' });
    return result;
}

function nullableCents(value) {
    return value === null || value === undefined || value === '' ? null : cents(value);
}

function quantityMilli(value) {
    const quantity = Number(value ?? 0);
    const result = Math.round(quantity * 1000);
    if (!Number.isFinite(quantity) || !Number.isSafeInteger(result)) {
        throw new ConsumerImportError('INVALID_QUANTITY', 'O backup contém uma quantidade de produto inválida.', { stage: 'transform' });
    }
    return result;
}

function localDateTime(value) {
    const source = cleanText(value);
    if (!source) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return source;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(source)) return source;
    return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(source) ? source : `${source}${LOCAL_OFFSET}`;
}

function parseBackupFileName(fileName) {
    const safeName = path.basename(String(fileName || 'backup-consumer.fbconsumer'));
    const match = safeName.match(/Bkp(?:Manual|Auto)?_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_v([0-9.]+)/i);
    return {
        fileName: safeName,
        backupCreatedAt: match
            ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${LOCAL_OFFSET}`
            : null,
        consumerVersion: match ? match[7].replace(/\.+$/, '') : null,
    };
}

function validIsoDate(value) {
    const source = cleanText(value);
    if (!source || !Number.isFinite(Date.parse(source))) return null;
    return source;
}

function latestCompletedBackup(store, sourceKey) {
    if (!store || typeof store.listImports !== 'function') return null;
    const imports = store.listImports({ sourceKey, limit: 250 });
    return (Array.isArray(imports) ? imports : [])
        .filter((item) => item?.status === 'completed' && validIsoDate(item.backupCreatedAt))
        .sort((left, right) => Date.parse(right.backupCreatedAt) - Date.parse(left.backupCreatedAt))[0] || null;
}

function schemaFingerprint() {
    const schema = ENTITY_DEFINITIONS.map((definition) => ({
        key: definition.key,
        table: definition.table,
        fields: definition.fields.map((field) => [field.name, field.type]),
    }));
    return crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

function assertSnapshotHasBusinessData(snapshot) {
    const collections = [
        'customers',
        'products',
        'orders',
        'orderItems',
        'orderPayments',
        'ledgerEntries',
        'deliveries',
    ];
    const total = collections.reduce((sum, key) => sum + (Array.isArray(snapshot?.[key]) ? snapshot[key].length : 0), 0);
    if (total > 0) return;
    throw new ConsumerImportError(
        'EMPTY_BACKUP_SNAPSHOT',
        'O backup não contém clientes, produtos, compras ou movimentações utilizáveis. A base atual foi preservada.',
        { stage: 'validation' },
    );
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        const input = fs.createReadStream(filePath);
        input.on('data', (chunk) => hash.update(chunk));
        input.once('error', reject);
        input.once('end', resolve);
    });
    return hash.digest('hex');
}

function notify(listener, stage, message, percent, details = {}) {
    if (typeof listener !== 'function') return;
    try {
        listener({
            etapa: stage,
            stage,
            mensagem: message,
            message,
            percentual: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
            percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
            ...details,
        });
    } catch {
        // A interface não pode interromper uma importação ou sua limpeza.
    }
}

function contactIdentifiers(contact) {
    const identifiers = [{ type: 'consumer_id', value: String(contact.id) }];
    const document = cleanText(contact.documento).replace(/\D/g, '');
    if (document.length === 11) identifiers.push({ type: 'cpf', value: document });
    else if (document.length === 14) identifiers.push({ type: 'cnpj', value: document });
    for (const value of [contact.celular, contact.telefonePrincipal, contact.telefoneRecados, contact.whatsappId]) {
        const phone = normalizePhoneDigits(value);
        if (phone) identifiers.push({ type: 'phone', value: phone });
    }
    const email = cleanText(contact.email).toLowerCase();
    if (email) identifiers.push({ type: 'email', value: email });
    const seen = new Set();
    return identifiers.filter((identifier) => {
        const key = `${identifier.type}:${identifier.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function paymentType(entry) {
    const amount = cents(entry.variacaoDivida);
    if (amount > 0) return 'charge';
    if (amount < 0) return 'payment';
    return 'adjustment';
}

function deliveryMode(type) {
    const normalized = cleanText(type).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/retir|pickup|balcao/.test(normalized)) return 'pickup';
    if (/entreg|delivery|endere|motoboy/.test(normalized)) return 'delivery';
    return 'unknown';
}

function adaptConsumerSnapshot(rawSnapshot, source = {}) {
    if (!rawSnapshot?.entities || typeof rawSnapshot.entities !== 'object') {
        throw new ConsumerImportError('INVALID_RAW_SNAPSHOT', 'O extrator não retornou um snapshot válido do Consumer.', { stage: 'transform' });
    }
    const entities = rawSnapshot.entities;
    const contacts = Array.isArray(entities.contatos) ? entities.contatos : [];
    const categories = new Map((entities.categorias || []).map((row) => [row.id, cleanText(row.descricao)]));
    const productsById = new Map((entities.produtos || []).map((row) => [row.id, row]));
    const detailsByProduct = new Map();
    for (const detail of entities.produtoDetalhes || []) {
        if (!detailsByProduct.has(detail.produtoId)) detailsByProduct.set(detail.produtoId, []);
        detailsByProduct.get(detail.produtoId).push(detail);
    }
    const orderOrigins = new Map((entities.origensPedido || []).map((row) => [row.id, cleanText(row.descricao)]));
    const ordersById = new Map((entities.pedidos || []).map((row) => [row.id, row]));
    const paymentMethods = new Map((entities.formasPagamento || []).map((row) => [row.id, cleanText(row.descricao)]));
    const deliveryTypes = new Map((entities.tiposEntrega || []).map((row) => [row.id, cleanText(row.descricao)]));
    const cancelledOrders = new Set((entities.pedidos || []).filter((row) => row.cancelado).map((row) => row.id));

    const customers = contacts.map((contact) => {
        const identifiers = contactIdentifiers(contact);
        const taxId = identifiers.find((item) => item.type === 'cpf' || item.type === 'cnpj')?.value || null;
        const phone = identifiers.find((item) => item.type === 'phone')?.value || null;
        return {
            externalId: external(contact.id),
            name: cleanText(contact.nome),
            active: contact.ativo !== false,
            taxId,
            phone,
            email: optionalText(contact.email)?.toLowerCase() || null,
            currentBalanceCents: nullableCents(contact.saldoAtual),
            identifiers,
            extra: {
                createdAt: localDateTime(contact.criadoEm),
                birthDate: localDateTime(contact.nascimento),
                city: optionalText(contact.cidade),
                neighborhood: optionalText(contact.bairro),
                state: optionalText(contact.uf),
                creditLimitCents: nullableCents(contact.limiteCredito),
            },
        };
    });

    const products = (entities.produtos || []).map((product) => {
        const details = detailsByProduct.get(product.id) || [];
        const preferred = details.find((detail) => detail.ativo !== false && !detail.pausadoEm) || details[0] || {};
        return {
            externalId: external(product.id),
            name: cleanText(product.nome),
            category: optionalText(categories.get(product.etiquetaId)),
            barcode: optionalText(preferred.codigoBarras),
            unit: product.itemPorKg ? 'kg' : null,
            active: product.ativo !== false && preferred.ativo !== false,
            salePriceCents: nullableCents(preferred.precoVenda ?? product.precoVenda),
            costPriceCents: nullableCents(preferred.precoCusto ?? product.precoCusto),
            extra: {
                consumerDetailIds: details.map((detail) => external(detail.id)),
                customCode: optionalText(product.codigoPersonalizado),
                itemByWeight: Boolean(product.itemPorKg),
                stockControlled: Boolean(product.estoqueControlado),
                currentStockMilli: product.estoqueAtual === null || product.estoqueAtual === undefined
                    ? null
                    : quantityMilli(product.estoqueAtual),
            },
        };
    });

    const orders = (entities.pedidos || []).map((order) => ({
        externalId: external(order.id),
        customerExternalId: external(order.clienteId),
        orderedAt: localDateTime(order.fechadoEm || order.abertoEm),
        status: order.cancelado ? 'cancelled' : (order.fechadoEm ? 'completed' : 'open'),
        origin: optionalText(orderOrigins.get(order.origemId)),
        subtotalCents: cents(order.valorItens ?? order.subtotalPago),
        discountCents: cents(order.totalDesconto),
        deliveryFeeCents: cents(order.valorEntrega),
        totalCents: cents(order.valorTotal),
        cancelled: Boolean(order.cancelado),
        extra: {
            openedAt: localDateTime(order.abertoEm),
            closedAt: localDateTime(order.fechadoEm),
            surchargeCents: cents(order.totalAcrescimo),
            serviceCents: cents(order.totalServico),
        },
    }));

    const orderItems = (entities.itensPedido || []).map((item) => {
        const product = productsById.get(item.produtoId);
        return {
            externalId: external(item.id),
            orderExternalId: external(item.pedidoId),
            productExternalId: external(item.produtoId),
            productName: cleanText(item.nomeProduto || product?.nome),
            category: optionalText(categories.get(product?.etiquetaId)),
            quantityMilli: quantityMilli(item.quantidade),
            unitPriceCents: cents(item.valorUnitario),
            totalCents: cents(item.valorTotal ?? item.valorItem),
            cancelled: Boolean(item.cancelado || cancelledOrders.has(item.pedidoId)),
            extra: {
                productDetailId: external(item.produtoDetalheId),
                registeredAt: localDateTime(item.cadastradoEm),
                producedAt: localDateTime(item.produzidoEm),
                deliveredAt: localDateTime(item.entregueEm),
                discountCents: cents(item.desconto),
                costPriceCents: cents(item.precoCusto),
            },
        };
    });

    const orderPayments = (entities.pagamentos || []).map((payment) => ({
        externalId: external(payment.id),
        orderExternalId: external(payment.pedidoId),
        customerExternalId: external(payment.contatoId),
        paidAt: localDateTime(payment.pagoEm || payment.creditoEm),
        method: optionalText(paymentMethods.get(payment.formaPagamentoId)),
        amountCents: cents(payment.valor),
        cancelled: Boolean(payment.cancelado || cancelledOrders.has(payment.pedidoId)),
        extra: {
            installment: payment.numeroParcela ?? null,
            prepaid: Boolean(payment.prepago),
            currentAccountId: external(payment.contaCorrenteId),
        },
    }));

    const ledgerEntries = (entities.contaCorrente || []).map((entry) => ({
        externalId: external(entry.id),
        customerExternalId: external(entry.clienteId),
        orderExternalId: external(entry.pedidoId),
        paymentExternalId: external(entry.pagamentoId),
        occurredAt: localDateTime(entry.ocorridoEm),
        type: paymentType(entry),
        description: optionalText(entry.observacao),
        amountCents: cents(entry.variacaoDivida),
        balanceCents: nullableCents(entry.saldoFinal),
        cancelled: Boolean(cancelledOrders.has(entry.pedidoId)),
        extra: {
            openingBalanceCents: nullableCents(entry.saldoInicial),
            creditCents: nullableCents(entry.credito),
            debitCents: nullableCents(entry.debito),
            reversedEntryId: external(entry.contaEstornadaId),
        },
    }));

    const deliveries = (entities.entregas || []).map((delivery) => {
        const order = ordersById.get(delivery.pedidoId);
        const typeDescription = deliveryTypes.get(delivery.tipoEntregaId);
        const occurredAt = delivery.entregueEm || delivery.retiradoEm || delivery.saiuParaEntregaEm
            || delivery.prontoParaRetiradaEm || delivery.entregaPrevistaEm || delivery.retiradaPrevistaEm;
        return {
            externalId: external(delivery.pedidoId),
            orderExternalId: external(delivery.pedidoId),
            customerExternalId: external(delivery.contatoId ?? order?.clienteId),
            occurredAt: localDateTime(occurredAt),
            mode: deliveryMode(typeDescription),
            city: optionalText(delivery.cidade),
            neighborhood: optionalText(delivery.bairro),
            feeCents: cents(delivery.frete ?? order?.valorEntrega),
            completed: Boolean(delivery.entregueEm || delivery.retiradoEm),
            cancelled: Boolean(cancelledOrders.has(delivery.pedidoId)),
            extra: {
                sourceType: optionalText(typeDescription),
                scheduled: Boolean(delivery.agendado),
                status: optionalText(delivery.status),
            },
        };
    });

    const orderIds = new Set(orders.map((row) => row.externalId));
    const missingItemOrder = orderItems.find((row) => row.orderExternalId && !orderIds.has(row.orderExternalId));
    if (missingItemOrder) {
        throw new ConsumerImportError('ORPHAN_ORDER_ITEM', 'O backup contém item sem o pedido correspondente; nada foi importado.', { stage: 'transform' });
    }

    const anonymousOrders = orders.filter((order) => !order.customerExternalId).length;
    const cancelledOrderCount = orders.filter((order) => order.cancelled).length;
    const inactiveCustomerCount = customers.filter((customer) => !customer.active).length;
    const warnings = [
        'O Consumer não forneceu vencimentos neste backup; saldos são tratados como em aberto, sem afirmar atraso.',
        'Compras sem cliente identificado entram apenas nos totais da loja, nunca em um perfil individual.',
        'Sem registro explícito de entrega ou retirada, o canal da compra permanece desconhecido.',
    ];
    if (anonymousOrders) warnings.push(`${anonymousOrders} pedido(s) não possuem cliente identificado.`);
    if (cancelledOrderCount) warnings.push(`${cancelledOrderCount} pedido(s) cancelados ou excluídos foram preservados, mas não entram nas métricas.`);
    if (inactiveCustomerCount) warnings.push(`${inactiveCustomerCount} cliente(s) inativos foram preservados, mas não entram nas campanhas nem no saldo ativo da loja.`);

    return {
        schemaVersion: 1,
        source: {
            sourceKey: cleanText(source.sourceKey) || DEFAULT_SOURCE_KEY,
            timezone: DEFAULT_TIMEZONE,
            sha256: cleanText(source.sha256).toLowerCase(),
            sourceKind: cleanText(source.sourceKind).toLowerCase().startsWith('drive') ? cleanText(source.sourceKind).toLowerCase() : 'local',
            sourceName: path.basename(String(source.sourceName || rawSnapshot.source?.fileName || 'backup-consumer.fbconsumer')),
            driveFileId: source.driveFileId || null,
            sizeBytes: Number(source.sizeBytes ?? rawSnapshot.source?.sizeBytes ?? 0),
            backupCreatedAt: source.backupCreatedAt || null,
            consumerVersion: source.consumerVersion || null,
            schemaFingerprint: source.schemaFingerprint || schemaFingerprint(),
            authoritativeSnapshot: true,
        },
        customers,
        products,
        orders,
        orderItems,
        orderPayments,
        ledgerEntries,
        deliveries,
        warnings,
    };
}

function portugueseSummary(counts = {}, business = {}) {
    return {
        clientes: Number(counts.customers || 0),
        produtos: Number(counts.products || 0),
        pedidos: Number(counts.orders || 0),
        itens: Number(counts.orderItems || 0),
        pagamentos: Number(counts.orderPayments || 0),
        contaCorrente: Number(counts.ledgerEntries || 0),
        entregas: Number(counts.deliveries || 0),
        perfis: Number(business.customers || counts.customers || 0),
        ticketMedioCentavos: Number(business.averageTicketCents || 0),
        saldoEmAbertoCentavos: Number(business.outstandingDebtCents || 0),
    };
}

async function validateImportFile(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    if (!SUPPORTED_BACKUP_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
        throw new ConsumerImportError('INVALID_BACKUP_EXTENSION', 'Selecione um backup FB, FBCONSUMER, FBK, GBK, BAK ou BACKUP.', { stage: 'validation' });
    }
    let stats;
    try {
        stats = await fsp.stat(resolved);
    } catch (error) {
        throw new ConsumerImportError('BACKUP_NOT_FOUND', 'O arquivo de backup não foi encontrado.', { stage: 'validation', cause: error });
    }
    if (!stats.isFile() || !stats.size) throw new ConsumerImportError('BACKUP_EMPTY', 'O arquivo de backup está vazio.', { stage: 'validation' });
    if (stats.size > MAX_BACKUP_BYTES) throw new ConsumerImportError('BACKUP_TOO_LARGE', 'O backup excede o limite de 2 GB.', { stage: 'validation' });
    return { filePath: resolved, sizeBytes: stats.size };
}

async function importConsumerBackup(options = {}) {
    const hasFile = Boolean(cleanText(options.filePath));
    const hasUrl = Boolean(cleanText(options.url));
    if (hasFile === hasUrl) {
        throw new ConsumerImportError('BACKUP_SOURCE_REQUIRED', 'Informe um arquivo local ou um link do Google Drive.', { stage: 'validation' });
    }

    const onProgress = options.onProgress;
    const requestedSourceKind = cleanText(options.sourceKind).toLowerCase();
    const sourceKind = requestedSourceKind.startsWith('drive')
        ? requestedSourceKind
        : (hasUrl ? 'drive' : 'local');
    const sourceKey = cleanText(options.sourceKey) || DEFAULT_SOURCE_KEY;
    const store = options.store || createConsumerStore(options.storeOptions || {});
    const ownsStore = !options.store;
    const extractor = options.extractor || extractConsumerBackup;
    const downloader = options.downloader || downloadGoogleDriveBackup;
    let temporaryDirectory = null;
    let workingPath = hasFile ? path.resolve(options.filePath) : '';
    let driveFileId = null;
    let downloadedName = '';
    let downloadedModifiedAt = null;
    let primaryError = null;

    try {
        store.initialize();
        if (hasUrl) {
            driveFileId = extractGoogleDriveFileId(options.url);
            temporaryDirectory = await fsp.mkdtemp(path.join(options.tempRoot || os.tmpdir(), 'valeverde-drive-'));
            const requestedExtension = SUPPORTED_BACKUP_EXTENSIONS.has(path.extname(String(options.sourceName || '')).toLowerCase())
                ? path.extname(String(options.sourceName)).toLowerCase()
                : '.fbconsumer';
            workingPath = path.join(temporaryDirectory, `backup-google-drive${requestedExtension}`);
            notify(onProgress, 'download', 'Baixando o backup do Google Drive…', 2);
            const downloaded = await downloader(options.url, workingPath, {
                onProgress: ({ received, total }) => {
                    const percent = total ? 2 + ((received / total) * 16) : null;
                    notify(onProgress, 'download', 'Baixando o backup do Google Drive…', percent, { receivedBytes: received, totalBytes: total });
                },
            });
            driveFileId = downloaded.fileId || driveFileId;
            downloadedName = downloaded.fileName || '';
            downloadedModifiedAt = validIsoDate(downloaded.modifiedAt || downloaded.modifiedTime || downloaded.updatedAt);
            const downloadedExtension = path.extname(downloadedName).toLowerCase();
            if (SUPPORTED_BACKUP_EXTENSIONS.has(downloadedExtension) && path.extname(workingPath).toLowerCase() !== downloadedExtension) {
                const renamedPath = path.join(temporaryDirectory, `backup-google-drive${downloadedExtension}`);
                await fsp.rename(workingPath, renamedPath);
                workingPath = renamedPath;
            }
        }

        notify(onProgress, 'validation', 'Validando o arquivo e calculando sua assinatura…', 20);
        const validated = await validateImportFile(workingPath);
        const sha256 = await sha256File(validated.filePath);
        const safeSourceName = path.basename(String(options.sourceName || (hasFile ? validated.filePath : (downloadedName || workingPath))));
        const parsedName = parseBackupFileName(safeSourceName);
        const backupCreatedAt = validIsoDate(
            options.backupCreatedAt
            || parsedName.backupCreatedAt
            || options.modifiedAt
            || downloadedModifiedAt
        );
        const consumerVersion = cleanText(options.consumerVersion) || parsedName.consumerVersion;
        driveFileId = cleanText(options.driveFileId) || driveFileId;
        const duplicate = store.findCompletedImportByHash(sourceKey, sha256);
        if (duplicate) {
            store.reconcileCompletedImportAsAuthoritative?.(duplicate.id);
            const business = store.getBusinessSummary({ sourceKey });
            notify(onProgress, 'completed', 'Esse backup já estava importado; nenhum dado foi duplicado.', 100);
            return {
                status: 'duplicate',
                arquivo: parsedName.fileName,
                origem: sourceKind,
                sha256,
                assinatura: sha256,
                importacaoId: duplicate.id,
                resumo: portugueseSummary(duplicate.counts, business),
                analytics: business,
                avisos: duplicate.warnings || [],
            };
        }

        const latest = latestCompletedBackup(store, sourceKey);
        if (latest && !backupCreatedAt && options.allowUndated !== true) {
            throw new ConsumerImportError(
                'BACKUP_DATE_UNKNOWN',
                'Este arquivo não informa sua data e existe um backup datado mais recente na base. Use a pasta sincronizada ou um arquivo com data verificável.',
                { stage: 'validation' },
            );
        }
        if (latest && Date.parse(latest.backupCreatedAt) > Date.parse(backupCreatedAt) && options.allowOlder !== true) {
            const business = store.getBusinessSummary({ sourceKey });
            notify(onProgress, 'completed', 'O backup selecionado é mais antigo que o já sincronizado; os dados atuais foram mantidos.', 100);
            return {
                status: 'older',
                arquivo: parsedName.fileName,
                origem: sourceKind,
                sha256,
                assinatura: sha256,
                importacaoId: latest.id,
                backupCreatedAt,
                latestBackupCreatedAt: latest.backupCreatedAt,
                resumo: portugueseSummary(latest.counts, business),
                analytics: business,
                avisos: ['O arquivo não foi importado porque existe um backup mais recente concluído para esta fonte.'],
            };
        }

        const raw = await extractor(validated.filePath, {
            ...options.extractorOptions,
            onProgress: (progress = {}) => {
                const fraction = progress.total ? progress.current / progress.total : null;
                const percent = fraction === null ? null : 25 + (fraction * 55);
                notify(onProgress, progress.stage || 'extract', progress.message || 'Lendo o backup do Consumer…', percent);
            },
        });
        notify(onProgress, 'transform', 'Organizando clientes, compras, pagamentos e entregas…', 82);
        const canonical = adaptConsumerSnapshot(raw, {
            sourceKey,
            sha256,
            sourceKind,
            sourceName: parsedName.fileName,
            driveFileId,
            sizeBytes: validated.sizeBytes,
            backupCreatedAt,
            consumerVersion,
        });
        assertSnapshotHasBusinessData(canonical);
        notify(onProgress, 'persist', 'Gravando o histórico na base analítica local…', 90);
        const result = store.importSnapshot(canonical);
        const business = result.summary || store.getBusinessSummary({ sourceKey });
        notify(onProgress, 'completed', 'Backup do Consumer importado com sucesso.', 100);
        return {
            status: result.status,
            arquivo: parsedName.fileName,
            origem: sourceKind,
            sha256,
            assinatura: sha256,
            importacaoId: result.importId,
            backupCreatedAt,
            resumo: portugueseSummary(result.counts, business),
            analytics: business,
            avisos: canonical.warnings,
        };
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        let cleanupFailure = null;
        try {
            if (ownsStore) store.close();
        } catch (closeError) {
            cleanupFailure = new ConsumerImportError('STORE_CLOSE_FAILED', 'Os dados foram processados, mas a base analítica não pôde ser fechada corretamente.', {
                stage: 'cleanup',
                cause: closeError,
            });
        }
        if (temporaryDirectory) {
            notify(onProgress, 'cleanup', 'Removendo o arquivo temporário baixado…', null);
            try {
                await fsp.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
            } catch (cleanupError) {
                cleanupFailure ||= new ConsumerImportError('TEMP_CLEANUP_FAILED', 'A importação terminou, mas o arquivo temporário baixado não pôde ser removido.', {
                    stage: 'cleanup',
                    cause: cleanupError,
                });
            }
        }
        if (!primaryError && cleanupFailure) throw cleanupFailure;
    }
}

module.exports = {
    ConsumerImportError,
    DEFAULT_SOURCE_KEY,
    DEFAULT_TIMEZONE,
    adaptConsumerSnapshot,
    assertSnapshotHasBusinessData,
    cents,
    importConsumerBackup,
    localDateTime,
    parseBackupFileName,
    portugueseSummary,
    schemaFingerprint,
    sha256File,
    validateImportFile,
};
