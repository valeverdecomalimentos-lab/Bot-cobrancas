const crypto = require('crypto');

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function createSignature(value) {
    return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

class SignatureCache {
    constructor(options = {}) {
        this.ttlMs = Math.max(0, Number(options.ttlMs ?? 5 * 60 * 1000));
        this.maxEntries = Math.max(1, Number(options.maxEntries ?? 50));
        this.now = options.now || Date.now;
        this.entries = new Map();
        this.hits = 0;
        this.misses = 0;
    }

    get(key, signature) {
        const cacheKey = String(key);
        const entry = this.entries.get(cacheKey);
        if (!entry || entry.signature !== signature || entry.expiresAt <= this.now()) {
            if (entry) this.entries.delete(cacheKey);
            this.misses += 1;
            return undefined;
        }
        this.entries.delete(cacheKey);
        this.entries.set(cacheKey, entry);
        this.hits += 1;
        return entry.value;
    }

    set(key, signature, value, ttlMs = this.ttlMs) {
        const cacheKey = String(key);
        this.entries.delete(cacheKey);
        this.entries.set(cacheKey, {
            signature,
            value,
            expiresAt: this.now() + Math.max(0, Number(ttlMs)),
        });
        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
        return value;
    }

    getOrCreate(key, signature, factory, ttlMs = this.ttlMs) {
        const cached = this.get(key, signature);
        if (cached !== undefined) return { value: cached, cached: true };
        return { value: this.set(key, signature, factory(), ttlMs), cached: false };
    }

    clear(key) {
        if (key === undefined) this.entries.clear();
        else this.entries.delete(String(key));
    }

    stats() {
        return { size: this.entries.size, hits: this.hits, misses: this.misses, ttlMs: this.ttlMs };
    }
}

module.exports = {
    SignatureCache,
    createSignature,
    stableStringify,
};
