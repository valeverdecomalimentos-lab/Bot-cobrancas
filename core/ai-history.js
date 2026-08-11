const fs = require('fs');
const path = require('path');

function cleanSessionId(value) {
    return String(value || 'default').trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'default';
}

function cleanMessageText(value, maxChars = 24000) {
    return String(value || '').replace(/\u0000/g, '').trim().slice(0, maxChars);
}

class ConversationHistory {
    constructor(options = {}) {
        this.filePath = options.filePath || '';
        this.maxConversations = Math.max(1, Number(options.maxConversations ?? 20));
        this.maxMessages = Math.max(2, Number(options.maxMessages ?? 30));
        this.now = options.now || (() => new Date());
        this.loaded = false;
        this.data = { version: 1, conversations: {} };
    }

    load() {
        if (this.loaded) return this.data;
        this.loaded = true;
        if (!this.filePath || !fs.existsSync(this.filePath)) return this.data;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed && parsed.conversations && typeof parsed.conversations === 'object') {
                this.data = { version: 1, conversations: parsed.conversations };
            }
        } catch {
            this.data = { version: 1, conversations: {} };
        }
        return this.data;
    }

    persist() {
        if (!this.filePath) return;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2), 'utf8');
        fs.renameSync(temporaryPath, this.filePath);
    }

    get(sessionId = 'default', options = {}) {
        this.load();
        const id = cleanSessionId(sessionId);
        const messages = this.data.conversations[id]?.messages || [];
        const limit = Math.max(0, Number(options.limit ?? this.maxMessages));
        return messages.slice(-limit).map((message) => ({ ...message }));
    }

    append(sessionId, role, text, metadata = {}) {
        const cleanText = cleanMessageText(text);
        if (!cleanText) return null;
        this.load();
        const id = cleanSessionId(sessionId);
        const now = this.now().toISOString();
        const conversation = this.data.conversations[id] || { id, createdAt: now, updatedAt: now, messages: [] };
        const message = {
            role: role === 'assistant' ? 'assistant' : 'user',
            text: cleanText,
            createdAt: now,
            ...(metadata.operation ? { operation: String(metadata.operation).slice(0, 60) } : {}),
        };
        conversation.messages.push(message);
        conversation.messages = conversation.messages.slice(-this.maxMessages);
        conversation.updatedAt = now;
        this.data.conversations[id] = conversation;
        this.prune();
        this.persist();
        return { ...message };
    }

    appendExchange(sessionId, question, answer, metadata = {}) {
        this.append(sessionId, 'user', question, metadata);
        this.append(sessionId, 'assistant', answer, metadata);
        return this.get(sessionId);
    }

    forPrompt(sessionId = 'default', options = {}) {
        const maxChars = Math.max(0, Number(options.maxChars ?? 7000));
        const messages = this.get(sessionId, { limit: options.limit ?? 10 });
        const selected = [];
        let used = 0;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            const text = cleanMessageText(message.text, Math.min(4000, maxChars));
            const size = text.length + 40;
            if (selected.length && used + size > maxChars) break;
            selected.unshift({ role: message.role, text });
            used += size;
        }
        return selected;
    }

    clear(sessionId) {
        this.load();
        if (sessionId === undefined) this.data.conversations = {};
        else delete this.data.conversations[cleanSessionId(sessionId)];
        this.persist();
    }

    prune() {
        const entries = Object.entries(this.data.conversations)
            .sort(([, left], [, right]) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
        this.data.conversations = Object.fromEntries(entries.slice(0, this.maxConversations));
    }
}

module.exports = {
    ConversationHistory,
    cleanSessionId,
};
