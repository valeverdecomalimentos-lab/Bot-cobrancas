const xlsx = require('xlsx');
const validator = require('./validator');

function stripHtml(text) {
    return String(text).replace(/<[^>]*>/g, ' ');
}

function buscarTelefoneNoTexto(text) {
    if (!text) return null;
    const valor = stripHtml(text);
    const padrao = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\d{4}[-\s]?\d{4}|\d{4}[-\s]?\d{4}|\d{11})/g;
    const encontrado = valor.match(padrao);
    if (!encontrado) return null;
    return encontrado[0];
}

function extrairTelefone(row, keyTelefone) {
    if (keyTelefone && row[keyTelefone]) {
        return row[keyTelefone];
    }

    const values = Object.values(row);
    for (const value of values) {
        const telefone = buscarTelefoneNoTexto(value);
        if (telefone) return telefone;
    }

    return "";
}

module.exports = {
    lerPlanilha: (caminho) => {
        const workbook = xlsx.readFile(caminho);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { defval: "" });
        
        return data.map(row => {
            const keys = Object.keys(row);
            const keyNome = keys.find(k => k.toLowerCase().includes('nome') || k.toLowerCase().includes('cliente'));
            const keyTelefone = keys.find(k => k.toLowerCase().includes('telefone') || k.toLowerCase().includes('celular') || k.toLowerCase().includes('contato'));
            const keyValor = keys.find(k => k.toLowerCase().includes('valor') || k.toLowerCase().includes('saldo'));
            const keyStatus = keys.find(k => k.toLowerCase().includes('status'));

            const telefoneRaw = extrairTelefone(row, keyTelefone);
            const telefoneFormatado = validator.formatarNumero(telefoneRaw);
            const nomeRaw = keyNome ? row[keyNome] : "Cliente";

            return {
                nome: String(nomeRaw).trim() || "Cliente",
                telefoneOriginal: telefoneRaw,
                telefoneValido: telefoneFormatado,
                valor: keyValor ? row[keyValor] : "0,00",
                status: keyStatus ? row[keyStatus] : "Devedor",
                linhaRaw: row
            };
        });
    }
};