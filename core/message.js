const fs = require('fs');
const path = require('path');
const config = require('../config');

module.exports = {
    montar: (cliente) => {
        const templatePath = path.join(__dirname, '..', 'templates', 'cobranca.txt');
        let template = "";
        try {
            template = fs.readFileSync(templatePath, 'utf8');
        } catch(e) {
            template = "Olá, {{nome}}! Seu saldo é R$ {{valor}}.";
        }

        let valorStr = cliente.valor;
        if(typeof valorStr === 'number') {
            valorStr = valorStr.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        return template
            .replace(/\{\{nome\}\}/g, cliente.nome)
            .replace(/\[cliente\]/g, cliente.nome)
            .replace(/\{\{valor\}\}/g, valorStr)
            .replace(/\[0,00\]/g, valorStr);
    }
};