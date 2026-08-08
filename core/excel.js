const xlsx = require('xlsx');
const validator = require('./validator');

function stripHtml(text) {
    return String(text || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buscarTelefoneNoTexto(text) {
    if (!text) return null;
    const valor = stripHtml(text);
    const padrao = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\d{4}[-\s]?\d{4}|\d{4}[-\s]?\d{4}|\d{11})/g;
    const encontrado = valor.match(padrao);
    return encontrado ? encontrado[0] : null;
}

function extrairTelefone(row, keyTelefone) {
    if (keyTelefone && row[keyTelefone]) {
        return buscarTelefoneNoTexto(String(row[keyTelefone])) || '';
    }

    const values = Object.values(row);
    for (const value of values) {
        const telefone = buscarTelefoneNoTexto(value);
        if (telefone) return telefone;
    }

    return "";
}

function separarNomeTelefone(text) {
    const clean = stripHtml(text);
    const telefone = buscarTelefoneNoTexto(clean);
    if (!telefone) {
        return { nome: clean, telefone: '' };
    }

    const nome = clean.replace(telefone, '').replace(/[\(\)\-\s]{2,}/g, ' ').trim();
    return {
        nome: nome || clean,
        telefone
    };
}

module.exports = {
    lerPlanilha: (caminho) => {
        const workbook = xlsx.readFile(caminho);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { defval: "" });

        return data.map(row => {
            const keys = Object.keys(row);
            const keyNome = keys.find(k => /nome|cliente/i.test(k));
            const keyTelefone = keys.find(k => /telefone|celular|contato|numero/i.test(k));
            const keyValor = keys.find(k => /valor|saldo|d[íi]vida|divida|devido/i.test(k));
            const keyStatus = keys.find(k => /status|situa/i.test(k));

            const rawNome = keyNome ? String(row[keyNome]) : '';
            const rawTelefone = extrairTelefone(row, keyTelefone);

            let nome = stripHtml(rawNome);
            let telefoneOriginal = stripHtml(rawTelefone);

            if (rawNome) {
                const parsed = separarNomeTelefone(rawNome);
                nome = parsed.nome;
                if (!telefoneOriginal) {
                    telefoneOriginal = parsed.telefone;
                }
            }

            const telefoneValido = validator.formatarNumero(telefoneOriginal);
            const valor = keyValor ? row[keyValor] : '0,00';
            const statusRaw = keyStatus ? row[keyStatus] : 'Devedor';

            return {
                nome: nome || 'Cliente',
                telefoneOriginal: telefoneOriginal || '',
                telefoneValido,
                valor,
                status: String(statusRaw).trim() || 'Devedor',
                linhaRaw: row
            };
        });
    }
};