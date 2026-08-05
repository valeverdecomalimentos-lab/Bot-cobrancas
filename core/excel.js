const xlsx = require('xlsx');
const validator = require('./validator');

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

            const telefoneRaw = keyTelefone ? row[keyTelefone] : "";
            const telefoneFormatado = validator.formatarNumero(telefoneRaw);

            return {
                nome: keyNome ? row[keyNome] : "Cliente",
                telefoneOriginal: telefoneRaw,
                telefoneValido: telefoneFormatado,
                valor: keyValor ? row[keyValor] : "0,00",
                status: keyStatus ? row[keyStatus] : "Devedor",
                linhaRaw: row
            };
        });
    }
};