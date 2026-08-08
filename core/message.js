const fs = require('fs');
const path = require('path');

function cleanText(value) {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

module.exports = {
    montar: (cliente, templateFile = 'cobranca.txt', mostrarRodapeContato = true) => {
        const templatePath = path.join(__dirname, '..', 'templates', templateFile || 'cobranca.txt');
        let template = "";
        try {
            template = fs.readFileSync(templatePath, 'utf8');
        } catch(e) {
            template = "Olá, {{nome}}! Seu saldo é R$ {{valor}}.";
        }

        const nome = cleanText(cliente.nome);
        const numero = cleanText(cliente.numero || cliente.telefoneOriginal || '');
        let valorStr = cliente.valor;

        if (valorStr === undefined || valorStr === null || String(valorStr).trim() === '') {
            valorStr = '0,00';
        }

        if (typeof valorStr === 'number') {
            valorStr = valorStr.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        } else {
            const cleanedValue = String(valorStr).trim().replace(/[R$\s]/g, '');
            const parsed = Number(cleanedValue.replace(/\./g, '').replace(',', '.'));
            if (!Number.isNaN(parsed)) {
                valorStr = parsed.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            } else {
                valorStr = String(valorStr).trim();
            }
        }

        let mensagem = template
            .replace(/\{\{nome\}\}/g, nome)
            .replace(/\[cliente\]/g, nome)
            .replace(/\{\{valor\}\}/g, valorStr)
            .replace(/\{\{numero\}\}/g, numero || 'não informado')
            .replace(/\[0,00\]/g, valorStr);

        const isAutomaticTemplate = /autom(a|á)tica/i.test(template);
        if (!isAutomaticTemplate) {
            mensagem = `Esta é uma mensagem automática da Vale Verde. Se você já pagou ou já regularizou sua dívida, responda esta mensagem por aqui com o comprovante ou com o que estiver incorreto.\n\n${mensagem}`;
        }

        if (mostrarRodapeContato && !isAutomaticTemplate && !template.includes('{{numero}}')) {
            mensagem += `\n\nCliente: ${nome} \nNúmero: ${numero || 'não informado'} \nValor: R$ ${valorStr}`;
        }

        return mensagem.trim();
    }
};