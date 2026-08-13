'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const DEFAULT_HISTORY_LIMITS = Object.freeze({
    orders: 50000,
    payments: 50000,
    ledger: 50000,
    itemsPerOrder: 20000,
    paymentsPerOrder: 20000,
    deliveriesPerOrder: 5000,
});
const MAX_HISTORY_LIMIT = 100000;

function defaultDatabasePath() {
    const dataDirectory = process.env.VALEVERDE_DATA_DIR || path.join(__dirname, '..', 'data');
    return path.join(dataDirectory, 'consumer-analytics.sqlite');
}

function text(value, fallback = '') {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
}

function optionalText(value) {
    const result = text(value);
    return result || null;
}

function externalId(value, field) {
    const result = text(value);
    if (!result) throw new TypeError(`${field} e obrigatorio.`);
    if (result.length > 512) throw new TypeError(`${field} excede 512 caracteres.`);
    return result;
}

function integer(value, field, fallback = 0) {
    if (value === undefined || value === null || value === '') return fallback;
    const result = Number(value);
    if (!Number.isSafeInteger(result)) {
        throw new TypeError(`${field} deve ser um numero inteiro seguro.`);
    }
    return result;
}

function nullableInteger(value, field) {
    if (value === undefined || value === null || value === '') return null;
    return integer(value, field);
}

function booleanInteger(value, fallback = false) {
    if (value === undefined || value === null) return fallback ? 1 : 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['0', 'false', 'nao', 'não', 'n', 'no'].includes(normalized)) return 0;
        if (['1', 'true', 'sim', 's', 'yes'].includes(normalized)) return 1;
    }
    return value ? 1 : 0;
}

function json(value, fallback) {
    try {
        return JSON.stringify(value === undefined ? fallback : value);
    } catch {
        return JSON.stringify(fallback);
    }
}

function parseJson(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function array(value) {
    return Array.isArray(value) ? value : [];
}

function normalizeIdentifier(type, value) {
    const kind = text(type, 'other').toLowerCase().slice(0, 40) || 'other';
    const original = text(value);
    if (!original) return null;

    let normalized;
    if (['cpf', 'cnpj', 'tax_id', 'document', 'phone', 'telefone', 'whatsapp'].includes(kind)) {
        normalized = original.replace(/\D/g, '');
    } else {
        normalized = original.toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
    }
    if (!normalized) return null;
    return { type: kind, value: original, normalizedValue: normalized };
}

function sourceFrom(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        throw new TypeError('O snapshot do Consumer e obrigatorio.');
    }
    const source = snapshot.source && typeof snapshot.source === 'object' ? snapshot.source : {};
    const sourceKey = text(source.sourceKey);
    const sha256 = text(source.sha256).toLowerCase();
    if (!sourceKey) throw new TypeError('snapshot.source.sourceKey e obrigatorio.');
    if (!sha256) throw new TypeError('snapshot.source.sha256 e obrigatorio.');
    if (sourceKey.length > 200) throw new TypeError('sourceKey excede 200 caracteres.');
    if (sha256.length > 128) throw new TypeError('sha256 excede 128 caracteres.');
    return { ...source, sourceKey, sha256 };
}

function syntheticId(prefix, row, index, parts = []) {
    const stable = parts.map((part) => text(part)).filter(Boolean).join('|') || json(row, {});
    const digest = crypto.createHash('sha256').update(stable).digest('hex').slice(0, 24);
    return `${prefix}:${digest}:${index}`;
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
    return Math.max(1, Math.min(MAX_LIMIT, integer(value, 'limit', fallback)));
}

function clampHistoryLimit(value, field, fallback) {
    return Math.max(1, Math.min(MAX_HISTORY_LIMIT, integer(value, field, fallback)));
}

function historyLimits(options = {}) {
    const configured = options.historyLimits && typeof options.historyLimits === 'object'
        ? options.historyLimits
        : {};
    const shared = options.historyLimit;
    const valueFor = (name) => configured[name]
        ?? options[`${name}Limit`]
        ?? shared
        ?? DEFAULT_HISTORY_LIMITS[name];
    return {
        orders: clampHistoryLimit(valueFor('orders'), 'historyLimits.orders', DEFAULT_HISTORY_LIMITS.orders),
        payments: clampHistoryLimit(valueFor('payments'), 'historyLimits.payments', DEFAULT_HISTORY_LIMITS.payments),
        ledger: clampHistoryLimit(valueFor('ledger'), 'historyLimits.ledger', DEFAULT_HISTORY_LIMITS.ledger),
        itemsPerOrder: clampHistoryLimit(valueFor('itemsPerOrder'), 'historyLimits.itemsPerOrder', DEFAULT_HISTORY_LIMITS.itemsPerOrder),
        paymentsPerOrder: clampHistoryLimit(valueFor('paymentsPerOrder'), 'historyLimits.paymentsPerOrder', DEFAULT_HISTORY_LIMITS.paymentsPerOrder),
        deliveriesPerOrder: clampHistoryLimit(valueFor('deliveriesPerOrder'), 'historyLimits.deliveriesPerOrder', DEFAULT_HISTORY_LIMITS.deliveriesPerOrder),
    };
}

function ledgerKind(row) {
    const amount = Number(row.amount_cents || 0);
    if (amount > 0) return 'charge';
    if (amount < 0) return 'payment';
    return 'adjustment';
}

function paymentStatus(cancelled, totalCents, paidCents) {
    if (cancelled) return 'cancelled';
    if (totalCents <= 0) return 'not_applicable';
    if (paidCents <= 0) return 'unpaid';
    if (paidCents < totalCents) return 'partial';
    return 'paid';
}

function mapImport(row) {
    if (!row) return null;
    return {
        id: row.id,
        sourceKey: row.source_key,
        sha256: row.sha256,
        sourceKind: row.source_kind || '',
        sourceName: row.source_name || '',
        driveFileId: row.drive_file_id || null,
        sizeBytes: row.size_bytes,
        backupCreatedAt: row.backup_created_at || null,
        consumerVersion: row.consumer_version || null,
        schemaFingerprint: row.schema_fingerprint || null,
        timezone: row.timezone || 'America/Sao_Paulo',
        status: row.status,
        importedAt: row.imported_at,
        completedAt: row.completed_at || null,
        counts: parseJson(row.counts_json, {}),
        warnings: parseJson(row.warnings_json, []),
    };
}

class ConsumerStore {
    constructor(options = {}) {
        this.databasePath = options.databasePath || defaultDatabasePath();
        this.database = null;
    }

    initialize() {
        if (this.database) return this;
        if (this.databasePath !== ':memory:') {
            fs.mkdirSync(path.dirname(path.resolve(this.databasePath)), { recursive: true });
        }

        this.database = new DatabaseSync(this.databasePath);
        this.database.exec(`
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA trusted_schema = OFF;

            CREATE TABLE IF NOT EXISTS imports (
                id INTEGER PRIMARY KEY,
                source_key TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                source_kind TEXT,
                source_name TEXT,
                drive_file_id TEXT,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                backup_created_at TEXT,
                consumer_version TEXT,
                schema_fingerprint TEXT,
                timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
                status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
                imported_at TEXT NOT NULL,
                completed_at TEXT,
                counts_json TEXT NOT NULL DEFAULT '{}',
                warnings_json TEXT NOT NULL DEFAULT '[]',
                source_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE (source_key, sha256)
            );

            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY,
                source_key TEXT NOT NULL,
                external_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                tax_id TEXT,
                phone TEXT,
                email TEXT,
                current_balance_cents INTEGER,
                first_import_id INTEGER NOT NULL REFERENCES imports(id),
                last_import_id INTEGER NOT NULL REFERENCES imports(id),
                extra_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE (source_key, external_id)
            );

            CREATE TABLE IF NOT EXISTS customer_identifiers (
                id INTEGER PRIMARY KEY,
                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                value TEXT NOT NULL,
                normalized_value TEXT NOT NULL,
                first_import_id INTEGER NOT NULL REFERENCES imports(id),
                last_import_id INTEGER NOT NULL REFERENCES imports(id),
                UNIQUE (customer_id, type, normalized_value)
            );

            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY,
                source_key TEXT NOT NULL,
                external_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                category TEXT,
                barcode TEXT,
                unit TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                sale_price_cents INTEGER,
                cost_price_cents INTEGER,
                first_import_id INTEGER NOT NULL REFERENCES imports(id),
                last_import_id INTEGER NOT NULL REFERENCES imports(id),
                extra_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE (source_key, external_id)
            );

            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY,
                source_key TEXT NOT NULL,
                external_id TEXT NOT NULL,
                customer_id INTEGER REFERENCES customers(id),
                ordered_at TEXT,
                status TEXT,
                origin TEXT,
                subtotal_cents INTEGER NOT NULL DEFAULT 0,
                discount_cents INTEGER NOT NULL DEFAULT 0,
                delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
                total_cents INTEGER NOT NULL DEFAULT 0,
                cancelled INTEGER NOT NULL DEFAULT 0,
                first_import_id INTEGER NOT NULL REFERENCES imports(id),
                last_import_id INTEGER NOT NULL REFERENCES imports(id),
                extra_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE (source_key, external_id)
            );

            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY,
                source_key TEXT NOT NULL,
                external_id TEXT NOT NULL,
                order_id INTEGER REFERENCES orders(id),
                product_id INTEGER REFERENCES products(id),
                product_name TEXT,
                category TEXT,
                quantity_milli INTEGER NOT NULL DEFAULT 0,
                unit_price_cents INTEGER NOT NULL DEFAULT 0,
                total_cents INTEGER NOT NULL DEFAULT 0,
                cancelled INTEGER NOT NULL DEFAULT 0,
                first_import_id INTEGER NOT NULL REFERENCES imports(id),
                last_import_id INTEGER NOT NULL REFERENCES imports(id),
                extra_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE (source_key, external_id)
            );

            CREATE TABLE IF NOT EXISTS order_payments (
                id INTEGER PRIMARY KEY,
                source_key TEXT NOT NULL,
                external_id TEXT NOT NULL,
                order_id INTEGER REFERENCES orders(id),
                customer_id INTEGER REFERENCES customers(id),
                paid_at TEXT,
                method TEXT,
                amount_cents INTEGER NOT NULL DEFAULT 0,
                cancelled INTEGER NOT NULL DEFAULT 0,
                first_import_id INTEGER NOT NULL REFERENCES imports(id),
                last_import_id INTEGER NOT NULL REFERENCES imports(id),
                extra_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE (source_key, external_id)
            );

            CREATE TABLE IF NOT EXISTS ledger_entries (
                id INTEGER PRIMARY KEY,
                source_key TEXT NOT NULL,
                external_id TEXT NOT NULL,
                customer_id INTEGER REFERENCES customers(id),
                order_id INTEGER REFERENCES orders(id),
                payment_id INTEGER REFERENCES order_payments(id),
                occurred_at TEXT,
                type TEXT,
                description TEXT,
                amount_cents INTEGER NOT NULL DEFAULT 0,
                balance_cents INTEGER,
                cancelled INTEGER NOT NULL DEFAULT 0,
                first_import_id INTEGER NOT NULL REFERENCES imports(id),
                last_import_id INTEGER NOT NULL REFERENCES imports(id),
                extra_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE (source_key, external_id)
            );

            CREATE TABLE IF NOT EXISTS deliveries (
                id INTEGER PRIMARY KEY,
                source_key TEXT NOT NULL,
                external_id TEXT NOT NULL,
                order_id INTEGER REFERENCES orders(id),
                customer_id INTEGER REFERENCES customers(id),
                occurred_at TEXT,
                mode TEXT,
                city TEXT,
                neighborhood TEXT,
                fee_cents INTEGER NOT NULL DEFAULT 0,
                completed INTEGER NOT NULL DEFAULT 0,
                cancelled INTEGER NOT NULL DEFAULT 0,
                first_import_id INTEGER NOT NULL REFERENCES imports(id),
                last_import_id INTEGER NOT NULL REFERENCES imports(id),
                extra_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE (source_key, external_id)
            );

            CREATE INDEX IF NOT EXISTS idx_imports_completed ON imports(source_key, status, completed_at);
            CREATE INDEX IF NOT EXISTS idx_customer_identifiers_value ON customer_identifiers(type, normalized_value);
            CREATE INDEX IF NOT EXISTS idx_orders_customer_date ON orders(customer_id, ordered_at);
            CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
            CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);
            CREATE INDEX IF NOT EXISTS idx_payments_customer_date ON order_payments(customer_id, paid_at);
            CREATE INDEX IF NOT EXISTS idx_ledger_customer_date ON ledger_entries(customer_id, occurred_at);
            CREATE INDEX IF NOT EXISTS idx_deliveries_customer ON deliveries(customer_id);
            PRAGMA user_version = ${SCHEMA_VERSION};
        `);
        this.database.exec(`
            UPDATE order_payments
            SET customer_id = (
                SELECT l.customer_id
                FROM ledger_entries l
                WHERE l.payment_id = order_payments.id AND l.customer_id IS NOT NULL
                ORDER BY l.id DESC
                LIMIT 1
            )
            WHERE customer_id IS NULL
              AND EXISTS (
                  SELECT 1 FROM ledger_entries l
                  WHERE l.payment_id = order_payments.id AND l.customer_id IS NOT NULL
              );
        `);
        return this;
    }

    _db() {
        if (!this.database) this.initialize();
        return this.database;
    }

    findCompletedImportByHash(sourceKey, sha256) {
        const row = this._db().prepare(`
            SELECT * FROM imports
            WHERE source_key = ? AND sha256 = ? AND status = 'completed'
            LIMIT 1
        `).get(text(sourceKey), text(sha256).toLowerCase());
        return mapImport(row);
    }

    importSnapshot(snapshot) {
        const source = sourceFrom(snapshot);
        const existing = this.findCompletedImportByHash(source.sourceKey, source.sha256);
        if (existing) {
            return { status: 'duplicate', importId: existing.id, import: existing, counts: existing.counts };
        }

        const db = this._db();
        const now = new Date().toISOString();
        const customers = array(snapshot.customers);
        const products = array(snapshot.products);
        const orders = array(snapshot.orders);
        const orderItems = array(snapshot.orderItems);
        const orderPayments = array(snapshot.orderPayments).length
            ? array(snapshot.orderPayments)
            : array(snapshot.payments);
        const ledgerEntries = array(snapshot.ledgerEntries);
        const deliveries = array(snapshot.deliveries);
        const counts = {
            customers: customers.length,
            products: products.length,
            orders: orders.length,
            orderItems: orderItems.length,
            orderPayments: orderPayments.length,
            ledgerEntries: ledgerEntries.length,
            deliveries: deliveries.length,
        };
        if (source.authoritativeSnapshot === true
            && Object.values(counts).every((count) => count === 0)) {
            throw new TypeError('Snapshot autoritativo vazio: a base atual foi preservada.');
        }

        db.exec('BEGIN IMMEDIATE');
        try {
            const duplicate = db.prepare(`
                SELECT * FROM imports
                WHERE source_key = ? AND sha256 = ? AND status = 'completed'
                LIMIT 1
            `).get(source.sourceKey, source.sha256);
            if (duplicate) {
                db.exec('ROLLBACK');
                const imported = mapImport(duplicate);
                return { status: 'duplicate', importId: imported.id, import: imported, counts: imported.counts };
            }

            const importResult = db.prepare(`
                INSERT INTO imports (
                    source_key, sha256, source_kind, source_name, drive_file_id, size_bytes,
                    backup_created_at, consumer_version, schema_fingerprint, timezone,
                    status, imported_at, counts_json, warnings_json, source_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, '{}', ?, ?)
            `).run(
                source.sourceKey,
                source.sha256,
                optionalText(source.sourceKind),
                optionalText(source.sourceName || source.fileName),
                optionalText(source.driveFileId),
                integer(source.sizeBytes, 'source.sizeBytes', 0),
                optionalText(source.backupCreatedAt),
                optionalText(source.consumerVersion),
                optionalText(source.schemaFingerprint),
                optionalText(source.timezone) || 'America/Sao_Paulo',
                now,
                json(snapshot.warnings || source.warnings, []),
                json(source, {})
            );
            const importId = Number(importResult.lastInsertRowid);

            this._upsertCustomers(source.sourceKey, importId, customers);
            this._upsertProducts(source.sourceKey, importId, products);
            this._upsertOrders(source.sourceKey, importId, orders);
            this._upsertOrderItems(source.sourceKey, importId, orderItems);
            this._upsertPayments(source.sourceKey, importId, orderPayments);
            this._upsertLedger(source.sourceKey, importId, ledgerEntries);
            this._upsertDeliveries(source.sourceKey, importId, deliveries);
            if (source.authoritativeSnapshot === true) {
                this._retireMissingSnapshotRows(source.sourceKey, importId);
            }

            const completedAt = new Date().toISOString();
            db.prepare(`
                UPDATE imports
                SET status = 'completed', completed_at = ?, counts_json = ?
                WHERE id = ?
            `).run(completedAt, json(counts, {}), importId);
            db.exec('COMMIT');

            const imported = this._importById(importId);
            return {
                status: 'completed',
                importId,
                import: imported,
                counts,
                summary: this.getBusinessSummary({ sourceKey: source.sourceKey }),
            };
        } catch (error) {
            try {
                db.exec('ROLLBACK');
            } catch {
                // Preserve the original import error.
            }
            throw error;
        }
    }

    _retireMissingSnapshotRows(sourceKey, importId) {
        const db = this._db();
        const source = text(sourceKey);
        const currentImport = integer(importId, 'importId');
        db.prepare(`
            DELETE FROM customer_identifiers
            WHERE last_import_id <> ?
              AND customer_id IN (
                  SELECT id FROM customers WHERE source_key = ? AND last_import_id = ?
              )
        `).run(currentImport, source, currentImport);
        for (const [table, assignment] of [
            ['customers', 'active = 0'],
            ['products', 'active = 0'],
            ['orders', 'cancelled = 1'],
            ['order_items', 'cancelled = 1'],
            ['order_payments', 'cancelled = 1'],
            ['ledger_entries', 'cancelled = 1'],
            ['deliveries', 'cancelled = 1'],
        ]) {
            db.prepare(`UPDATE ${table} SET ${assignment} WHERE source_key = ? AND last_import_id <> ?`)
                .run(source, currentImport);
        }
    }

    _upsertCustomers(sourceKey, importId, rows) {
        const db = this._db();
        const upsert = db.prepare(`
            INSERT INTO customers (
                source_key, external_id, name, active, tax_id, phone, email,
                current_balance_cents, first_import_id, last_import_id, extra_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_key, external_id) DO UPDATE SET
                name = excluded.name,
                active = excluded.active,
                tax_id = COALESCE(excluded.tax_id, customers.tax_id),
                phone = COALESCE(excluded.phone, customers.phone),
                email = COALESCE(excluded.email, customers.email),
                current_balance_cents = COALESCE(excluded.current_balance_cents, customers.current_balance_cents),
                last_import_id = excluded.last_import_id,
                extra_json = excluded.extra_json
        `);
        const getCustomer = db.prepare('SELECT id FROM customers WHERE source_key = ? AND external_id = ?');
        const insertIdentifier = db.prepare(`
            INSERT INTO customer_identifiers (
                customer_id, type, value, normalized_value, first_import_id, last_import_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(customer_id, type, normalized_value) DO UPDATE SET
                value = excluded.value,
                last_import_id = excluded.last_import_id
        `);

        rows.forEach((row, index) => {
            if (!row || typeof row !== 'object') throw new TypeError(`customers[${index}] e invalido.`);
            const id = externalId(row.externalId ?? row.id, `customers[${index}].externalId`);
            const taxId = optionalText(row.taxId ?? row.cpfCnpj ?? row.document);
            const phone = optionalText(row.phone ?? row.telephone ?? row.whatsapp);
            const email = optionalText(row.email);
            upsert.run(
                sourceKey,
                id,
                text(row.name ?? row.nome),
                booleanInteger(row.active ?? row.ativo, true),
                taxId,
                phone,
                email,
                nullableInteger(row.currentBalanceCents ?? row.balanceCents ?? row.debtCents, `customers[${index}].currentBalanceCents`),
                importId,
                importId,
                json(row.extra ?? row.raw, {})
            );

            const customerId = Number(getCustomer.get(sourceKey, id).id);
            const identifiers = array(row.identifiers).map((identifier) => {
                if (typeof identifier === 'string') return normalizeIdentifier('other', identifier);
                return normalizeIdentifier(identifier?.type, identifier?.value ?? identifier?.normalizedValue);
            });
            identifiers.push(normalizeIdentifier('tax_id', taxId));
            identifiers.push(normalizeIdentifier('phone', phone));
            identifiers.push(normalizeIdentifier('email', email));
            for (const identifier of identifiers.filter(Boolean)) {
                insertIdentifier.run(
                    customerId,
                    identifier.type,
                    identifier.value,
                    identifier.normalizedValue,
                    importId,
                    importId
                );
            }
        });
    }

    _upsertProducts(sourceKey, importId, rows) {
        const statement = this._db().prepare(`
            INSERT INTO products (
                source_key, external_id, name, category, barcode, unit, active,
                sale_price_cents, cost_price_cents, first_import_id, last_import_id, extra_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_key, external_id) DO UPDATE SET
                name = excluded.name,
                category = COALESCE(excluded.category, products.category),
                barcode = COALESCE(excluded.barcode, products.barcode),
                unit = COALESCE(excluded.unit, products.unit),
                active = excluded.active,
                sale_price_cents = COALESCE(excluded.sale_price_cents, products.sale_price_cents),
                cost_price_cents = COALESCE(excluded.cost_price_cents, products.cost_price_cents),
                last_import_id = excluded.last_import_id,
                extra_json = excluded.extra_json
        `);
        rows.forEach((row, index) => {
            if (!row || typeof row !== 'object') throw new TypeError(`products[${index}] e invalido.`);
            statement.run(
                sourceKey,
                externalId(row.externalId ?? row.id, `products[${index}].externalId`),
                text(row.name ?? row.nome),
                optionalText(row.category ?? row.categoria),
                optionalText(row.barcode ?? row.codigoBarras),
                optionalText(row.unit ?? row.unidade),
                booleanInteger(row.active ?? row.ativo, true),
                nullableInteger(row.salePriceCents ?? row.priceCents, `products[${index}].salePriceCents`),
                nullableInteger(row.costPriceCents, `products[${index}].costPriceCents`),
                importId,
                importId,
                json(row.extra ?? row.raw, {})
            );
        });
    }

    _idFor(table, sourceKey, id) {
        if (!id) return null;
        const allowed = new Set(['customers', 'products', 'orders', 'order_payments']);
        if (!allowed.has(table)) throw new Error('Tabela interna invalida.');
        const row = this._db().prepare(`SELECT id FROM ${table} WHERE source_key = ? AND external_id = ?`).get(sourceKey, text(id));
        return row ? Number(row.id) : null;
    }

    _upsertOrders(sourceKey, importId, rows) {
        const statement = this._db().prepare(`
            INSERT INTO orders (
                source_key, external_id, customer_id, ordered_at, status, origin,
                subtotal_cents, discount_cents, delivery_fee_cents, total_cents,
                cancelled, first_import_id, last_import_id, extra_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_key, external_id) DO UPDATE SET
                customer_id = COALESCE(excluded.customer_id, orders.customer_id),
                ordered_at = COALESCE(excluded.ordered_at, orders.ordered_at),
                status = COALESCE(excluded.status, orders.status),
                origin = COALESCE(excluded.origin, orders.origin),
                subtotal_cents = excluded.subtotal_cents,
                discount_cents = excluded.discount_cents,
                delivery_fee_cents = excluded.delivery_fee_cents,
                total_cents = excluded.total_cents,
                cancelled = excluded.cancelled,
                last_import_id = excluded.last_import_id,
                extra_json = excluded.extra_json
        `);
        rows.forEach((row, index) => {
            if (!row || typeof row !== 'object') throw new TypeError(`orders[${index}] e invalido.`);
            statement.run(
                sourceKey,
                externalId(row.externalId ?? row.id, `orders[${index}].externalId`),
                this._idFor('customers', sourceKey, row.customerExternalId ?? row.customerId),
                optionalText(row.orderedAt ?? row.createdAt ?? row.date),
                optionalText(row.status),
                optionalText(row.origin ?? row.origem),
                integer(row.subtotalCents, `orders[${index}].subtotalCents`, 0),
                integer(row.discountCents, `orders[${index}].discountCents`, 0),
                integer(row.deliveryFeeCents, `orders[${index}].deliveryFeeCents`, 0),
                integer(row.totalCents ?? row.amountCents, `orders[${index}].totalCents`, 0),
                booleanInteger(row.cancelled ?? row.canceled, false),
                importId,
                importId,
                json(row.extra ?? row.raw, {})
            );
        });
    }

    _upsertOrderItems(sourceKey, importId, rows) {
        const statement = this._db().prepare(`
            INSERT INTO order_items (
                source_key, external_id, order_id, product_id, product_name, category,
                quantity_milli, unit_price_cents, total_cents, cancelled,
                first_import_id, last_import_id, extra_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_key, external_id) DO UPDATE SET
                order_id = COALESCE(excluded.order_id, order_items.order_id),
                product_id = COALESCE(excluded.product_id, order_items.product_id),
                product_name = COALESCE(excluded.product_name, order_items.product_name),
                category = COALESCE(excluded.category, order_items.category),
                quantity_milli = excluded.quantity_milli,
                unit_price_cents = excluded.unit_price_cents,
                total_cents = excluded.total_cents,
                cancelled = excluded.cancelled,
                last_import_id = excluded.last_import_id,
                extra_json = excluded.extra_json
        `);
        rows.forEach((row, index) => {
            if (!row || typeof row !== 'object') throw new TypeError(`orderItems[${index}] e invalido.`);
            const orderExternal = row.orderExternalId ?? row.orderId;
            const productExternal = row.productExternalId ?? row.productId;
            const id = text(row.externalId ?? row.id) || syntheticId('item', row, index, [orderExternal, productExternal]);
            let quantityMilli;
            if (row.quantityMilli !== undefined && row.quantityMilli !== null) {
                quantityMilli = integer(row.quantityMilli, `orderItems[${index}].quantityMilli`);
            } else if (row.quantity !== undefined && row.quantity !== null) {
                const converted = Number(row.quantity) * 1000;
                if (!Number.isSafeInteger(converted)) throw new TypeError(`orderItems[${index}].quantity nao pode ser representada em milesimos.`);
                quantityMilli = converted;
            } else {
                quantityMilli = 1000;
            }
            statement.run(
                sourceKey,
                id,
                this._idFor('orders', sourceKey, orderExternal),
                this._idFor('products', sourceKey, productExternal),
                optionalText(row.productName ?? row.description ?? row.nome),
                optionalText(row.category ?? row.categoria),
                quantityMilli,
                integer(row.unitPriceCents, `orderItems[${index}].unitPriceCents`, 0),
                integer(row.totalCents, `orderItems[${index}].totalCents`, 0),
                booleanInteger(row.cancelled ?? row.canceled, false),
                importId,
                importId,
                json(row.extra ?? row.raw, {})
            );
        });
    }

    _upsertPayments(sourceKey, importId, rows) {
        const statement = this._db().prepare(`
            INSERT INTO order_payments (
                source_key, external_id, order_id, customer_id, paid_at, method,
                amount_cents, cancelled, first_import_id, last_import_id, extra_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_key, external_id) DO UPDATE SET
                order_id = COALESCE(excluded.order_id, order_payments.order_id),
                customer_id = COALESCE(excluded.customer_id, order_payments.customer_id),
                paid_at = COALESCE(excluded.paid_at, order_payments.paid_at),
                method = COALESCE(excluded.method, order_payments.method),
                amount_cents = excluded.amount_cents,
                cancelled = excluded.cancelled,
                last_import_id = excluded.last_import_id,
                extra_json = excluded.extra_json
        `);
        rows.forEach((row, index) => {
            if (!row || typeof row !== 'object') throw new TypeError(`orderPayments[${index}] e invalido.`);
            const orderExternal = row.orderExternalId ?? row.orderId;
            const customerExternal = row.customerExternalId ?? row.customerId;
            const id = text(row.externalId ?? row.id) || syntheticId('payment', row, index, [orderExternal, customerExternal, row.paidAt, row.amountCents]);
            const orderId = this._idFor('orders', sourceKey, orderExternal);
            let customerId = this._idFor('customers', sourceKey, customerExternal);
            if (!customerId && orderId) {
                customerId = this._db().prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId)?.customer_id || null;
            }
            statement.run(
                sourceKey,
                id,
                orderId,
                customerId,
                optionalText(row.paidAt ?? row.occurredAt ?? row.date),
                optionalText(row.method ?? row.paymentMethod),
                integer(row.amountCents ?? row.totalCents, `orderPayments[${index}].amountCents`, 0),
                booleanInteger(row.cancelled ?? row.canceled, false),
                importId,
                importId,
                json(row.extra ?? row.raw, {})
            );
        });
    }

    _upsertLedger(sourceKey, importId, rows) {
        const statement = this._db().prepare(`
            INSERT INTO ledger_entries (
                source_key, external_id, customer_id, order_id, payment_id,
                occurred_at, type, description, amount_cents, balance_cents, cancelled,
                first_import_id, last_import_id, extra_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_key, external_id) DO UPDATE SET
                customer_id = COALESCE(excluded.customer_id, ledger_entries.customer_id),
                order_id = COALESCE(excluded.order_id, ledger_entries.order_id),
                payment_id = COALESCE(excluded.payment_id, ledger_entries.payment_id),
                occurred_at = COALESCE(excluded.occurred_at, ledger_entries.occurred_at),
                type = COALESCE(excluded.type, ledger_entries.type),
                description = COALESCE(excluded.description, ledger_entries.description),
                amount_cents = excluded.amount_cents,
                balance_cents = COALESCE(excluded.balance_cents, ledger_entries.balance_cents),
                cancelled = excluded.cancelled,
                last_import_id = excluded.last_import_id,
                extra_json = excluded.extra_json
        `);
        const linkPaymentCustomer = this._db().prepare(`
            UPDATE order_payments
            SET customer_id = COALESCE(customer_id, ?)
            WHERE id = ?
        `);
        rows.forEach((row, index) => {
            if (!row || typeof row !== 'object') throw new TypeError(`ledgerEntries[${index}] e invalido.`);
            const customerExternal = row.customerExternalId ?? row.customerId;
            const orderExternal = row.orderExternalId ?? row.orderId;
            const paymentExternal = row.paymentExternalId ?? row.paymentId;
            const id = text(row.externalId ?? row.id) || syntheticId('ledger', row, index, [customerExternal, row.occurredAt, row.amountCents ?? row.debtDeltaCents]);
            const customerId = this._idFor('customers', sourceKey, customerExternal);
            const paymentId = this._idFor('order_payments', sourceKey, paymentExternal);
            statement.run(
                sourceKey,
                id,
                customerId,
                this._idFor('orders', sourceKey, orderExternal),
                paymentId,
                optionalText(row.occurredAt ?? row.date),
                optionalText(row.type),
                optionalText(row.description),
                integer(row.amountCents ?? row.debtDeltaCents, `ledgerEntries[${index}].amountCents`, 0),
                nullableInteger(row.balanceCents, `ledgerEntries[${index}].balanceCents`),
                booleanInteger(row.cancelled ?? row.canceled, false),
                importId,
                importId,
                json(row.extra ?? row.raw, {})
            );
            if (customerId && paymentId) linkPaymentCustomer.run(customerId, paymentId);
        });
    }

    _upsertDeliveries(sourceKey, importId, rows) {
        const statement = this._db().prepare(`
            INSERT INTO deliveries (
                source_key, external_id, order_id, customer_id, occurred_at, mode,
                city, neighborhood, fee_cents, completed, cancelled,
                first_import_id, last_import_id, extra_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_key, external_id) DO UPDATE SET
                order_id = COALESCE(excluded.order_id, deliveries.order_id),
                customer_id = COALESCE(excluded.customer_id, deliveries.customer_id),
                occurred_at = COALESCE(excluded.occurred_at, deliveries.occurred_at),
                mode = COALESCE(excluded.mode, deliveries.mode),
                city = COALESCE(excluded.city, deliveries.city),
                neighborhood = COALESCE(excluded.neighborhood, deliveries.neighborhood),
                fee_cents = excluded.fee_cents,
                completed = excluded.completed,
                cancelled = excluded.cancelled,
                last_import_id = excluded.last_import_id,
                extra_json = excluded.extra_json
        `);
        rows.forEach((row, index) => {
            if (!row || typeof row !== 'object') throw new TypeError(`deliveries[${index}] e invalido.`);
            const orderExternal = row.orderExternalId ?? row.orderId;
            const customerExternal = row.customerExternalId ?? row.customerId;
            const id = text(row.externalId ?? row.id) || syntheticId('delivery', row, index, [orderExternal, row.occurredAt, row.mode]);
            const orderId = this._idFor('orders', sourceKey, orderExternal);
            let customerId = this._idFor('customers', sourceKey, customerExternal);
            if (!customerId && orderId) {
                customerId = this._db().prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId)?.customer_id || null;
            }
            statement.run(
                sourceKey,
                id,
                orderId,
                customerId,
                optionalText(row.occurredAt ?? row.deliveredAt ?? row.date),
                optionalText(row.mode ?? row.type),
                optionalText(row.city),
                optionalText(row.neighborhood ?? row.district),
                integer(row.feeCents, `deliveries[${index}].feeCents`, 0),
                booleanInteger(row.completed, false),
                booleanInteger(row.cancelled ?? row.canceled, false),
                importId,
                importId,
                json(row.extra ?? row.raw, {})
            );
        });
    }

    _importById(id) {
        return mapImport(this._db().prepare('SELECT * FROM imports WHERE id = ?').get(id));
    }

    reconcileCompletedImportAsAuthoritative(importId) {
        const id = integer(importId, 'importId');
        const row = this._db().prepare(`
            SELECT * FROM imports WHERE id = ? AND status = 'completed'
        `).get(id);
        if (!row) return { reconciled: false, reason: 'not_found' };
        const latest = this._db().prepare(`
            SELECT id FROM imports
            WHERE source_key = ? AND status = 'completed'
            ORDER BY id DESC LIMIT 1
        `).get(row.source_key);
        if (Number(latest?.id) !== id) return { reconciled: false, reason: 'not_latest' };
        const savedSource = parseJson(row.source_json, {});
        if (savedSource.authoritativeSnapshot === true) {
            return { reconciled: false, reason: 'already_authoritative' };
        }
        const savedCounts = parseJson(row.counts_json, {});
        const businessCounts = [
            'customers',
            'products',
            'orders',
            'orderItems',
            'orderPayments',
            'ledgerEntries',
            'deliveries',
        ].map((field) => Number(savedCounts[field] || 0));
        if (businessCounts.every((count) => count === 0)) {
            return { reconciled: false, reason: 'empty_snapshot' };
        }

        this._db().exec('BEGIN IMMEDIATE');
        try {
            this._retireMissingSnapshotRows(row.source_key, id);
            this._db().prepare('UPDATE imports SET source_json = ? WHERE id = ?')
                .run(json({ ...savedSource, authoritativeSnapshot: true }, {}), id);
            this._db().exec('COMMIT');
            return { reconciled: true, importId: id, sourceKey: row.source_key };
        } catch (error) {
            try { this._db().exec('ROLLBACK'); } catch { /* preserve original */ }
            throw error;
        }
    }

    listImports(options = {}) {
        const normalized = typeof options === 'number' ? { limit: options } : (options || {});
        const limit = clampLimit(normalized.limit, 100);
        const offset = Math.max(0, integer(normalized.offset, 'offset', 0));
        const sourceKey = optionalText(normalized.sourceKey);
        const rows = sourceKey
            ? this._db().prepare(`SELECT * FROM imports WHERE source_key = ? ORDER BY id DESC LIMIT ? OFFSET ?`).all(sourceKey, limit, offset)
            : this._db().prepare(`SELECT * FROM imports ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset);
        return rows.map(mapImport);
    }

    getBusinessSummary(options = {}) {
        const sourceKey = typeof options === 'string' ? options : optionalText(options?.sourceKey);
        const db = this._db();
        const where = sourceKey ? 'WHERE source_key = ?' : '';
        const activeWhere = sourceKey ? 'WHERE source_key = ? AND cancelled = 0' : 'WHERE cancelled = 0';
        const args = sourceKey ? [sourceKey] : [];
        const scalar = (table, clause = where, parameters = args) => Number(db.prepare(`SELECT COUNT(*) AS value FROM ${table} ${clause}`).get(...parameters).value);

        const customerTotals = db.prepare(`
            SELECT COUNT(*) AS total, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active
            FROM customers ${where}
        `).get(...args);
        const orderTotals = db.prepare(`
            SELECT COUNT(*) AS total, COALESCE(SUM(total_cents), 0) AS amount,
                   MIN(ordered_at) AS first_at, MAX(ordered_at) AS last_at
            FROM orders ${activeWhere}
        `).get(...args);
        const paymentTotals = db.prepare(`
            SELECT COUNT(*) AS total, COALESCE(SUM(amount_cents), 0) AS amount, MAX(paid_at) AS last_at
            FROM order_payments ${activeWhere}
        `).get(...args);
        const ledgerTotals = db.prepare(`
            SELECT
                SUM(CASE WHEN cancelled = 0 AND amount_cents > 0 THEN 1 ELSE 0 END) AS charges,
                COALESCE(SUM(CASE WHEN cancelled = 0 AND amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS charged,
                SUM(CASE WHEN cancelled = 0 AND amount_cents < 0 THEN 1 ELSE 0 END) AS debt_payments,
                COALESCE(SUM(CASE WHEN cancelled = 0 AND amount_cents < 0 THEN -amount_cents ELSE 0 END), 0) AS debt_paid,
                MAX(CASE WHEN cancelled = 0 AND amount_cents < 0 THEN occurred_at END) AS last_debt_payment_at
            FROM ledger_entries ${where}
        `).get(...args);

        const debtRows = db.prepare(`
            SELECT c.id, c.current_balance_cents,
                   COALESCE(SUM(CASE WHEN l.cancelled = 0 THEN l.amount_cents ELSE 0 END), 0) AS delta
            FROM customers c
            LEFT JOIN ledger_entries l ON l.customer_id = c.id
            ${sourceKey ? 'WHERE c.source_key = ? AND c.active = 1' : 'WHERE c.active = 1'}
            GROUP BY c.id
        `).all(...args);
        let outstandingDebtCents = 0;
        let customersWithDebt = 0;
        for (const row of debtRows) {
            const balance = row.current_balance_cents === null ? Number(row.delta) : Number(row.current_balance_cents);
            if (balance > 0) {
                outstandingDebtCents += balance;
                customersWithDebt += 1;
            }
        }

        const topPaymentMethods = db.prepare(`
            SELECT COALESCE(NULLIF(TRIM(method), ''), 'nao_informado') AS method,
                   COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total_cents
            FROM order_payments
            ${sourceKey ? 'WHERE source_key = ? AND cancelled = 0' : 'WHERE cancelled = 0'}
            GROUP BY COALESCE(NULLIF(TRIM(method), ''), 'nao_informado')
            ORDER BY total_cents DESC, count DESC, method ASC
            LIMIT 10
        `).all(...args).map((row) => ({ method: row.method, count: Number(row.count), totalCents: Number(row.total_cents) }));

        const topCategories = db.prepare(`
            SELECT COALESCE(NULLIF(TRIM(oi.category), ''), NULLIF(TRIM(p.category), ''), 'sem_categoria') AS category,
                   COUNT(*) AS itemCount, COALESCE(SUM(oi.quantity_milli), 0) AS quantity_milli,
                   COALESCE(SUM(oi.total_cents), 0) AS total_cents
            FROM order_items oi
            LEFT JOIN products p ON p.id = oi.product_id
            ${sourceKey ? 'WHERE oi.source_key = ? AND oi.cancelled = 0' : 'WHERE oi.cancelled = 0'}
            GROUP BY COALESCE(NULLIF(TRIM(oi.category), ''), NULLIF(TRIM(p.category), ''), 'sem_categoria')
            ORDER BY total_cents DESC, quantity_milli DESC, category ASC
            LIMIT 10
        `).all(...args).map((row) => ({
            category: row.category,
            itemCount: Number(row.itemCount),
            quantityMilli: Number(row.quantity_milli),
            totalCents: Number(row.total_cents),
        }));

        const deliveryRows = db.prepare(`
            SELECT mode, COUNT(*) AS total
            FROM deliveries ${activeWhere}
            GROUP BY mode
        `).all(...args);
        const fulfillment = { delivery: 0, pickup: 0, other: 0 };
        for (const row of deliveryRows) {
            const mode = text(row.mode).toLowerCase();
            if (/retir|pickup|balcao|balcão/.test(mode)) fulfillment.pickup += Number(row.total);
            else if (/entreg|delivery|endere|motoboy/.test(mode)) fulfillment.delivery += Number(row.total);
            else fulfillment.other += Number(row.total);
        }

        const ordersCount = Number(orderTotals.total);
        const revenueCents = Number(orderTotals.amount);
        return {
            sourceKey: sourceKey || null,
            imports: Number(db.prepare(`SELECT COUNT(*) AS value FROM imports ${sourceKey ? "WHERE source_key = ? AND status = 'completed'" : "WHERE status = 'completed'"}`).get(...args).value),
            customers: Number(customerTotals.total),
            activeCustomers: Number(customerTotals.active || 0),
            products: scalar('products'),
            orders: ordersCount,
            orderItems: scalar('order_items', activeWhere),
            payments: Number(paymentTotals.total),
            ledgerEntries: scalar('ledger_entries', activeWhere),
            deliveries: scalar('deliveries', activeWhere),
            revenueCents,
            averageTicketCents: ordersCount ? Math.round(revenueCents / ordersCount) : 0,
            paidTotalCents: Number(paymentTotals.amount),
            ledgerChargeCount: Number(ledgerTotals.charges || 0),
            ledgerChargeTotalCents: Number(ledgerTotals.charged || 0),
            debtPaymentCount: Number(ledgerTotals.debt_payments || 0),
            debtPaidTotalCents: Number(ledgerTotals.debt_paid || 0),
            lastDebtPaymentAt: ledgerTotals.last_debt_payment_at || null,
            outstandingDebtCents,
            customersWithDebt,
            firstOrderAt: orderTotals.first_at || null,
            lastOrderAt: orderTotals.last_at || null,
            lastPaymentAt: paymentTotals.last_at || null,
            fulfillment,
            topPaymentMethods,
            topCategories,
        };
    }

    listCustomerProfiles(options = {}) {
        const normalized = typeof options === 'string' ? { sourceKey: options } : (options || {});
        const sourceKey = optionalText(normalized.sourceKey);
        const search = optionalText(normalized.search);
        const limit = clampLimit(normalized.limit);
        const offset = Math.max(0, integer(normalized.offset, 'offset', 0));
        const clauses = [];
        const parameters = [];
        if (sourceKey) {
            clauses.push('c.source_key = ?');
            parameters.push(sourceKey);
        }
        if (search) {
            clauses.push(`(
                LOWER(c.name) LIKE LOWER(?) OR
                EXISTS (
                    SELECT 1 FROM customer_identifiers ci
                    WHERE ci.customer_id = c.id AND LOWER(ci.normalized_value) LIKE LOWER(?)
                )
            )`);
            const pattern = `%${search}%`;
            parameters.push(pattern, pattern);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const customers = this._db().prepare(`
            SELECT c.* FROM customers c
            ${where}
            ORDER BY LOWER(c.name), c.external_id
            LIMIT ? OFFSET ?
        `).all(...parameters, limit, offset);

        const includeHistory = normalized.includeHistory === true;
        let profiles = customers.map((customer) => this._buildProfile(customer, {
            ...normalized,
            includeHistory,
        }));
        if (normalized.onlyDebtors) profiles = profiles.filter((profile) => profile.currentDebtCents > 0);
        return profiles;
    }

    listCustomerHistoryProfiles(options = {}) {
        const normalized = typeof options === 'string' ? { sourceKey: options } : (options || {});
        return this.listCustomerProfiles({ ...normalized, includeHistory: true });
    }

    getCustomerProfile(sourceKeyOrOptions, externalIdValue) {
        const options = sourceKeyOrOptions && typeof sourceKeyOrOptions === 'object'
            ? sourceKeyOrOptions
            : { sourceKey: sourceKeyOrOptions, externalId: externalIdValue };
        const sourceKey = text(options.sourceKey);
        const id = text(options.externalId ?? options.id);
        if (!sourceKey || !id) return null;
        const customer = this._db().prepare(`
            SELECT * FROM customers WHERE source_key = ? AND external_id = ? LIMIT 1
        `).get(sourceKey, id);
        return customer ? this._buildProfile(customer, {
            ...options,
            includeHistory: options.includeHistory !== false,
        }) : null;
    }

    _buildProfile(customer, options = {}) {
        const db = this._db();
        const customerId = Number(customer.id);
        const identifiers = db.prepare(`
            SELECT type, value, normalized_value FROM customer_identifiers
            WHERE customer_id = ? ORDER BY type, normalized_value
        `).all(customerId).map((row) => ({
            type: row.type,
            value: row.value,
            normalizedValue: row.normalized_value,
        }));
        const orderRows = db.prepare(`
            SELECT id, external_id, ordered_at, status, origin, subtotal_cents,
                   discount_cents, delivery_fee_cents, total_cents
            FROM orders
            WHERE customer_id = ? AND cancelled = 0
            ORDER BY ordered_at, id
        `).all(customerId);
        const paymentRows = db.prepare(`
            SELECT id, external_id, order_id, paid_at, method, amount_cents
            FROM order_payments
            WHERE customer_id = ? AND cancelled = 0
            ORDER BY paid_at, id
        `).all(customerId);
        const ledgerRows = db.prepare(`
            SELECT id, external_id, order_id, payment_id, occurred_at, type,
                   description, amount_cents, balance_cents
            FROM ledger_entries
            WHERE customer_id = ? AND cancelled = 0
            ORDER BY COALESCE(occurred_at, ''), id
        `).all(customerId);
        const deliveryRows = db.prepare(`
            SELECT order_id, mode FROM deliveries WHERE customer_id = ? AND cancelled = 0
        `).all(customerId);

        const totalPurchasedCents = orderRows.reduce((sum, row) => sum + Number(row.total_cents), 0);
        const paidTotalCents = paymentRows.reduce((sum, row) => sum + Number(row.amount_cents), 0);
        const ledgerDelta = ledgerRows.reduce((sum, row) => sum + Number(row.amount_cents), 0);
        const ledgerCharges = ledgerRows.filter((row) => Number(row.amount_cents) > 0);
        const ledgerPayments = ledgerRows.filter((row) => Number(row.amount_cents) < 0);
        const paymentById = new Map(paymentRows.map((row) => [Number(row.id), row]));
        const settlementByOrder = new Map(orderRows.map((row) => [Number(row.id), {
            orderPaymentCents: 0,
            ledgerOnlyPaymentCents: 0,
            paymentDates: [],
        }]));
        for (const payment of paymentRows) {
            const settlement = settlementByOrder.get(Number(payment.order_id));
            const amount = Number(payment.amount_cents);
            if (!settlement || amount <= 0) continue;
            settlement.orderPaymentCents += amount;
            if (payment.paid_at) settlement.paymentDates.push(payment.paid_at);
        }
        for (const entry of ledgerPayments) {
            const linkedPayment = paymentById.get(Number(entry.payment_id));
            const resolvedOrderId = Number(entry.order_id || linkedPayment?.order_id || 0);
            const settlement = settlementByOrder.get(resolvedOrderId);
            if (!settlement) continue;
            if (linkedPayment && Number(linkedPayment.order_id) === resolvedOrderId) continue;
            settlement.ledgerOnlyPaymentCents += Math.abs(Number(entry.amount_cents));
            if (entry.occurred_at) settlement.paymentDates.push(entry.occurred_at);
        }
        const partialOrders = orderRows.filter((row) => {
            const settlement = settlementByOrder.get(Number(row.id));
            const recordedPaid = settlement.orderPaymentCents + settlement.ledgerOnlyPaymentCents;
            return recordedPaid > 0 && recordedPaid < Number(row.total_cents);
        });
        const lastPartialPaymentAt = partialOrders
            .flatMap((row) => settlementByOrder.get(Number(row.id)).paymentDates)
            .filter(Boolean)
            .sort((left, right) => Date.parse(left) - Date.parse(right))
            .at(-1) || null;
        const ledgerPaymentTimestamps = ledgerPayments
            .map((row) => Date.parse(row.occurred_at))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        const ledgerPaymentGaps = [];
        for (let index = 1; index < ledgerPaymentTimestamps.length; index += 1) {
            ledgerPaymentGaps.push((ledgerPaymentTimestamps[index] - ledgerPaymentTimestamps[index - 1]) / 86400000);
        }
        const averageDaysBetweenDebtPayments = ledgerPaymentGaps.length
            ? Math.round((ledgerPaymentGaps.reduce((sum, value) => sum + value, 0) / ledgerPaymentGaps.length) * 10) / 10
            : null;
        const lastLedgerWithBalance = [...ledgerRows].reverse().find((row) => row.balance_cents !== null);
        const rawBalance = customer.current_balance_cents !== null
            ? Number(customer.current_balance_cents)
            : (lastLedgerWithBalance ? Number(lastLedgerWithBalance.balance_cents) : ledgerDelta);
        const currentDebtCents = Math.max(0, rawBalance);

        const timestamps = orderRows
            .map((row) => Date.parse(row.ordered_at))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        const gaps = [];
        for (let index = 1; index < timestamps.length; index += 1) {
            gaps.push((timestamps[index] - timestamps[index - 1]) / 86400000);
        }
        const averageDaysBetweenPurchases = gaps.length
            ? Math.round((gaps.reduce((sum, value) => sum + value, 0) / gaps.length) * 10) / 10
            : null;
        const paymentTimestamps = paymentRows
            .map((row) => Date.parse(row.paid_at))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        const paymentGaps = [];
        for (let index = 1; index < paymentTimestamps.length; index += 1) {
            paymentGaps.push((paymentTimestamps[index] - paymentTimestamps[index - 1]) / 86400000);
        }
        const averageDaysBetweenPayments = paymentGaps.length
            ? Math.round((paymentGaps.reduce((sum, value) => sum + value, 0) / paymentGaps.length) * 10) / 10
            : null;

        const productRows = db.prepare(`
            SELECT COALESCE(p.external_id, '') AS external_id,
                   COALESCE(NULLIF(oi.product_name, ''), NULLIF(p.name, ''), 'Produto sem nome') AS product_name,
                   COALESCE(NULLIF(oi.category, ''), NULLIF(p.category, ''), 'sem_categoria') AS product_category,
                   SUM(oi.quantity_milli) AS quantity_milli, SUM(oi.total_cents) AS total_cents,
                   COUNT(*) AS item_count
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            LEFT JOIN products p ON p.id = oi.product_id
            WHERE o.customer_id = ? AND o.cancelled = 0 AND oi.cancelled = 0
            GROUP BY p.id,
                     COALESCE(NULLIF(oi.product_name, ''), NULLIF(p.name, ''), 'Produto sem nome'),
                     COALESCE(NULLIF(oi.category, ''), NULLIF(p.category, ''), 'sem_categoria')
            ORDER BY total_cents DESC, quantity_milli DESC, product_name ASC
            LIMIT 10
        `).all(customerId);
        const categoryRows = db.prepare(`
            SELECT COALESCE(NULLIF(oi.category, ''), NULLIF(p.category, ''), 'sem_categoria') AS category,
                   SUM(oi.quantity_milli) AS quantity_milli, SUM(oi.total_cents) AS total_cents,
                   COUNT(*) AS item_count
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            LEFT JOIN products p ON p.id = oi.product_id
            WHERE o.customer_id = ? AND o.cancelled = 0 AND oi.cancelled = 0
            GROUP BY COALESCE(NULLIF(oi.category, ''), NULLIF(p.category, ''), 'sem_categoria')
            ORDER BY total_cents DESC, quantity_milli DESC, category ASC
            LIMIT 10
        `).all(customerId);
        const diversity = db.prepare(`
            SELECT COUNT(DISTINCT oi.product_id) AS products,
                   COUNT(DISTINCT COALESCE(NULLIF(oi.category, ''), NULLIF(p.category, ''))) AS categories
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            LEFT JOIN products p ON p.id = oi.product_id
            WHERE o.customer_id = ? AND o.cancelled = 0 AND oi.cancelled = 0
        `).get(customerId);

        const paymentMethodsMap = new Map();
        for (const payment of paymentRows) {
            const method = optionalText(payment.method) || 'nao_informado';
            const current = paymentMethodsMap.get(method) || { method, count: 0, totalCents: 0 };
            current.count += 1;
            current.totalCents += Number(payment.amount_cents);
            paymentMethodsMap.set(method, current);
        }
        const paymentMethods = [...paymentMethodsMap.values()].sort((a, b) => b.totalCents - a.totalCents || b.count - a.count || a.method.localeCompare(b.method));
        const orderOriginsMap = new Map();
        for (const order of orderRows) {
            const origin = optionalText(order.origin) || 'nao_informada';
            orderOriginsMap.set(origin, (orderOriginsMap.get(origin) || 0) + 1);
        }
        const orderOrigins = [...orderOriginsMap.entries()]
            .map(([origin, count]) => ({ origin, count }))
            .sort((left, right) => right.count - left.count || left.origin.localeCompare(right.origin));

        const fulfillment = { delivery: 0, pickup: 0, inStore: 0, other: 0, unknown: 0 };
        const ordersWithExplicitFulfillment = new Set();
        for (const delivery of deliveryRows) {
            if (delivery.order_id) ordersWithExplicitFulfillment.add(Number(delivery.order_id));
            const mode = text(delivery.mode).toLowerCase();
            if (/retir|pickup|balcao|balcão/.test(mode)) fulfillment.pickup += 1;
            else if (/entreg|delivery|endere|motoboy/.test(mode)) fulfillment.delivery += 1;
            else fulfillment.other += 1;
        }
        for (const order of orderRows) {
            if (ordersWithExplicitFulfillment.has(Number(order.id))) continue;
            const origin = text(order.origin).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            if (/balcao|loja|presencial|mesa|comanda/.test(origin)) fulfillment.inStore += 1;
            else fulfillment.unknown += 1;
        }
        const preferredFulfillment = Object.entries(fulfillment)
            .filter(([mode, count]) => mode !== 'unknown' && count > 0)
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || 'unknown';

        return {
            sourceKey: customer.source_key,
            externalId: customer.external_id,
            name: customer.name,
            active: Boolean(customer.active),
            taxId: customer.tax_id || null,
            phone: customer.phone || null,
            email: customer.email || null,
            identifiers,
            currentDebtCents,
            rawBalanceCents: rawBalance,
            orderCount: orderRows.length,
            totalPurchasedCents,
            averageTicketCents: orderRows.length ? Math.round(totalPurchasedCents / orderRows.length) : 0,
            firstPurchaseAt: orderRows[0]?.ordered_at || null,
            lastPurchaseAt: orderRows.at(-1)?.ordered_at || null,
            averageDaysBetweenPurchases,
            paymentCount: paymentRows.length,
            paidTotalCents,
            lastPaymentAt: paymentRows.at(-1)?.paid_at || null,
            averageDaysBetweenPayments,
            paymentMethods,
            partialPaymentOrderCount: partialOrders.length,
            lastPartialPaymentAt,
            ledgerChargeCount: ledgerCharges.length,
            ledgerChargeTotalCents: ledgerCharges.reduce((sum, row) => sum + Number(row.amount_cents), 0),
            debtPaymentCount: ledgerPayments.length,
            debtPaidTotalCents: ledgerPayments.reduce((sum, row) => sum + Math.abs(Number(row.amount_cents)), 0),
            lastDebtPaymentAt: ledgerPayments.at(-1)?.occurred_at || null,
            averageDaysBetweenDebtPayments,
            distinctProducts: Number(diversity.products || 0),
            distinctCategories: Number(diversity.categories || 0),
            favoriteProducts: productRows.map((row) => ({
                externalId: row.external_id || null,
                name: row.product_name,
                category: row.product_category,
                quantityMilli: Number(row.quantity_milli),
                totalCents: Number(row.total_cents),
                itemCount: Number(row.item_count),
            })),
            favoriteCategories: categoryRows.map((row) => ({
                category: row.category,
                quantityMilli: Number(row.quantity_milli),
                totalCents: Number(row.total_cents),
                itemCount: Number(row.item_count),
            })),
            orderOrigins,
            fulfillment,
            preferredFulfillment,
            extra: parseJson(customer.extra_json, {}),
            ...(options.includeHistory ? this._buildHistory(customerId, options) : {}),
        };
    }

    _buildHistory(customerId, options = {}) {
        const db = this._db();
        const limits = historyLimits(options);
        const numericCustomerId = Number(customerId);

        const orderCount = Number(db.prepare(`
            SELECT COUNT(*) AS total FROM orders WHERE customer_id = ?
        `).get(numericCustomerId).total);
        const paymentCount = Number(db.prepare(`
            SELECT COUNT(*) AS total
            FROM order_payments op
            LEFT JOIN orders o ON o.id = op.order_id
            WHERE op.customer_id = ? OR o.customer_id = ?
        `).get(numericCustomerId, numericCustomerId).total);
        const ledgerCount = Number(db.prepare(`
            SELECT COUNT(*) AS total
            FROM ledger_entries l
            LEFT JOIN orders direct_order ON direct_order.id = l.order_id
            LEFT JOIN order_payments linked_payment ON linked_payment.id = l.payment_id
            LEFT JOIN orders payment_order ON payment_order.id = linked_payment.order_id
            WHERE l.customer_id = ? OR direct_order.customer_id = ?
               OR linked_payment.customer_id = ? OR payment_order.customer_id = ?
        `).get(numericCustomerId, numericCustomerId, numericCustomerId, numericCustomerId).total);
        const itemCount = Number(db.prepare(`
            SELECT COUNT(*) AS total
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            WHERE o.customer_id = ?
        `).get(numericCustomerId).total);
        const deliveryCount = Number(db.prepare(`
            SELECT COUNT(*) AS total
            FROM deliveries d
            LEFT JOIN orders o ON o.id = d.order_id
            WHERE d.customer_id = ? OR o.customer_id = ?
        `).get(numericCustomerId, numericCustomerId).total);

        const orderRows = db.prepare(`
            SELECT id, external_id, ordered_at, status, origin, subtotal_cents,
                   discount_cents, delivery_fee_cents, total_cents, cancelled
            FROM orders
            WHERE customer_id = ?
            ORDER BY COALESCE(ordered_at, '') DESC, id DESC
            LIMIT ?
        `).all(numericCustomerId, limits.orders);
        const paymentRows = db.prepare(`
            SELECT op.id, op.external_id, op.order_id, o.external_id AS order_external_id,
                   op.paid_at, op.method, op.amount_cents, op.cancelled
            FROM order_payments op
            LEFT JOIN orders o ON o.id = op.order_id
            WHERE op.customer_id = ? OR o.customer_id = ?
            ORDER BY COALESCE(op.paid_at, '') DESC, op.id DESC
            LIMIT ?
        `).all(numericCustomerId, numericCustomerId, limits.payments);
        const ledgerRows = db.prepare(`
            SELECT l.id, l.external_id, l.occurred_at, l.type, l.description,
                   l.amount_cents, l.balance_cents, l.cancelled,
                   COALESCE(direct_order.external_id, payment_order.external_id) AS order_external_id,
                   linked_payment.external_id AS payment_external_id
            FROM ledger_entries l
            LEFT JOIN orders direct_order ON direct_order.id = l.order_id
            LEFT JOIN order_payments linked_payment ON linked_payment.id = l.payment_id
            LEFT JOIN orders payment_order ON payment_order.id = linked_payment.order_id
            WHERE l.customer_id = ? OR direct_order.customer_id = ?
               OR linked_payment.customer_id = ? OR payment_order.customer_id = ?
            ORDER BY COALESCE(l.occurred_at, '') DESC, l.id DESC
            LIMIT ?
        `).all(numericCustomerId, numericCustomerId, numericCustomerId, numericCustomerId, limits.ledger);

        const itemStatement = db.prepare(`
            SELECT oi.external_id, p.external_id AS product_external_id,
                   COALESCE(NULLIF(oi.product_name, ''), NULLIF(p.name, ''), 'Produto sem nome') AS product_name,
                   COALESCE(NULLIF(oi.category, ''), NULLIF(p.category, ''), 'sem_categoria') AS product_category,
                   oi.quantity_milli, oi.unit_price_cents, oi.total_cents, oi.cancelled
            FROM order_items oi
            LEFT JOIN products p ON p.id = oi.product_id
            WHERE oi.order_id = ?
            ORDER BY oi.id
            LIMIT ?
        `);
        const itemCountStatement = db.prepare(`SELECT COUNT(*) AS total FROM order_items WHERE order_id = ?`);
        const orderPaymentStatement = db.prepare(`
            SELECT external_id, paid_at, method, amount_cents, cancelled
            FROM order_payments
            WHERE order_id = ?
            ORDER BY COALESCE(paid_at, '') DESC, id DESC
            LIMIT ?
        `);
        const orderPaymentCountStatement = db.prepare(`SELECT COUNT(*) AS total FROM order_payments WHERE order_id = ?`);
        const deliveryStatement = db.prepare(`
            SELECT external_id, occurred_at, mode, city, neighborhood, fee_cents, completed, cancelled
            FROM deliveries
            WHERE order_id = ?
            ORDER BY COALESCE(occurred_at, '') DESC, id DESC
            LIMIT ?
        `);
        const deliveryCountStatement = db.prepare(`SELECT COUNT(*) AS total FROM deliveries WHERE order_id = ?`);
        const directSettlementStatement = db.prepare(`
            SELECT COALESCE(SUM(CASE WHEN cancelled = 0 AND amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS paid,
                   MAX(CASE WHEN cancelled = 0 AND amount_cents > 0 THEN paid_at END) AS last_paid_at
            FROM order_payments
            WHERE order_id = ?
        `);
        const ledgerSettlementStatement = db.prepare(`
            SELECT COALESCE(SUM(
                       CASE
                           WHEN l.cancelled = 0 AND l.amount_cents < 0
                            AND NOT (
                                linked_payment.id IS NOT NULL
                                AND linked_payment.order_id = ?
                                AND linked_payment.cancelled = 0
                                AND linked_payment.amount_cents > 0
                            )
                           THEN -l.amount_cents
                           ELSE 0
                       END
                   ), 0) AS paid,
                   MAX(
                       CASE
                           WHEN l.cancelled = 0 AND l.amount_cents < 0
                            AND NOT (
                                linked_payment.id IS NOT NULL
                                AND linked_payment.order_id = ?
                                AND linked_payment.cancelled = 0
                                AND linked_payment.amount_cents > 0
                            )
                           THEN l.occurred_at
                       END
                   ) AS last_paid_at
            FROM ledger_entries l
            LEFT JOIN order_payments linked_payment ON linked_payment.id = l.payment_id
            WHERE COALESCE(l.order_id, linked_payment.order_id) = ?
        `);

        const ordersHistory = orderRows.map((row) => {
            const orderId = Number(row.id);
            const totalCents = Number(row.total_cents);
            const directSettlement = directSettlementStatement.get(orderId);
            const ledgerSettlement = ledgerSettlementStatement.get(orderId, orderId, orderId);
            const orderPaymentCents = Number(directSettlement.paid || 0);
            const ledgerOnlyPaymentCents = Number(ledgerSettlement.paid || 0);
            const recordedPaidTotalCents = orderPaymentCents + ledgerOnlyPaymentCents;
            const status = paymentStatus(Boolean(row.cancelled), totalCents, recordedPaidTotalCents);
            const itemTotal = Number(itemCountStatement.get(orderId).total);
            const orderPaymentTotal = Number(orderPaymentCountStatement.get(orderId).total);
            const orderDeliveryTotal = Number(deliveryCountStatement.get(orderId).total);
            const items = itemStatement.all(orderId, limits.itemsPerOrder).map((item) => ({
                externalId: item.external_id,
                productExternalId: item.product_external_id || null,
                productName: item.product_name,
                category: item.product_category,
                quantityMilli: Number(item.quantity_milli),
                unitPriceCents: Number(item.unit_price_cents),
                totalCents: Number(item.total_cents),
                cancelled: Boolean(item.cancelled),
            }));
            const payments = orderPaymentStatement.all(orderId, limits.paymentsPerOrder).map((payment) => ({
                externalId: payment.external_id,
                paidAt: payment.paid_at || null,
                method: payment.method || null,
                amountCents: Number(payment.amount_cents),
                cancelled: Boolean(payment.cancelled),
            }));
            const deliveries = deliveryStatement.all(orderId, limits.deliveriesPerOrder).map((delivery) => ({
                externalId: delivery.external_id,
                occurredAt: delivery.occurred_at || null,
                mode: delivery.mode || null,
                city: delivery.city || null,
                neighborhood: delivery.neighborhood || null,
                feeCents: Number(delivery.fee_cents),
                completed: Boolean(delivery.completed),
                cancelled: Boolean(delivery.cancelled),
            }));
            const evidenceDates = [directSettlement.last_paid_at, ledgerSettlement.last_paid_at]
                .filter(Boolean)
                .sort((left, right) => Date.parse(left) - Date.parse(right));
            const evidenceSources = [];
            if (orderPaymentCents > 0) evidenceSources.push('order_payments');
            if (ledgerOnlyPaymentCents > 0) evidenceSources.push('ledger_entries');

            return {
                externalId: row.external_id,
                orderedAt: row.ordered_at || null,
                status: row.status || null,
                origin: row.origin || null,
                subtotalCents: Number(row.subtotal_cents),
                discountCents: Number(row.discount_cents),
                deliveryFeeCents: Number(row.delivery_fee_cents),
                totalCents,
                cancelled: Boolean(row.cancelled),
                paymentStatus: status,
                partialPayment: status === 'partial',
                recordedPaidTotalCents,
                recordedRemainingCents: Math.max(0, totalCents - recordedPaidTotalCents),
                lastRecordedPaymentAt: evidenceDates.at(-1) || null,
                paymentEvidence: {
                    orderPaymentsCents: orderPaymentCents,
                    associatedLedgerPaymentsCents: ledgerOnlyPaymentCents,
                    sources: evidenceSources,
                },
                items,
                payments,
                deliveries,
                historyTruncated: {
                    items: itemTotal > items.length,
                    payments: orderPaymentTotal > payments.length,
                    deliveries: orderDeliveryTotal > deliveries.length,
                },
            };
        });

        const paymentsHistory = paymentRows.map((row) => ({
            externalId: row.external_id,
            orderExternalId: row.order_external_id || null,
            paidAt: row.paid_at || null,
            method: row.method || null,
            amountCents: Number(row.amount_cents),
            cancelled: Boolean(row.cancelled),
        }));
        const ledgerHistory = ledgerRows.map((row) => ({
            externalId: row.external_id,
            occurredAt: row.occurred_at || null,
            kind: ledgerKind(row),
            sourceType: row.type || null,
            description: row.description || null,
            amountCents: Number(row.amount_cents),
            balanceCents: row.balance_cents === null ? null : Number(row.balance_cents),
            orderExternalId: row.order_external_id || null,
            paymentExternalId: row.payment_external_id || null,
            cancelled: Boolean(row.cancelled),
        }));
        const returnedItems = ordersHistory.reduce((sum, order) => sum + order.items.length, 0);
        const returnedDeliveries = ordersHistory.reduce((sum, order) => sum + order.deliveries.length, 0);
        const nestedTruncated = ordersHistory.some((order) => Object.values(order.historyTruncated).some(Boolean));
        const truncated = {
            orders: orderCount > ordersHistory.length,
            payments: paymentCount > paymentsHistory.length,
            ledger: ledgerCount > ledgerHistory.length,
            items: itemCount > returnedItems,
            deliveries: deliveryCount > returnedDeliveries,
        };

        return {
            ordersHistory,
            paymentsHistory,
            ledgerHistory,
            historyMeta: {
                limits,
                totals: {
                    orders: orderCount,
                    payments: paymentCount,
                    ledger: ledgerCount,
                    items: itemCount,
                    deliveries: deliveryCount,
                },
                returned: {
                    orders: ordersHistory.length,
                    payments: paymentsHistory.length,
                    ledger: ledgerHistory.length,
                    items: returnedItems,
                    deliveries: returnedDeliveries,
                },
                truncated: {
                    ...truncated,
                    any: nestedTruncated || Object.values(truncated).some(Boolean),
                },
            },
        };
    }

    close() {
        if (!this.database) return;
        this.database.close();
        this.database = null;
    }
}

function createConsumerStore(options = {}) {
    return new ConsumerStore(options);
}

module.exports = {
    SCHEMA_VERSION,
    DEFAULT_HISTORY_LIMITS,
    MAX_HISTORY_LIMIT,
    ConsumerStore,
    createConsumerStore,
};
