const { getTemplateByFile } = require('./templates-store');
const { cleanText, formatMoney, getDebtAmount } = require('./customer-utils');

function resolveTemplate(templateFile) {
    const template = getTemplateByFile(templateFile || 'cobranca.txt');
    if (!template) {
        throw new Error(`Template nao encontrado: ${templateFile || 'cobranca.txt'}`);
    }
    return template;
}

function firstName(name) {
    return cleanText(name).split(/\s+/).filter(Boolean)[0] || '';
}

function formatMessage(cliente, templateText, mostrarRodapeContato = true) {
    const template = String(templateText || '').trim();
    if (!template) throw new Error('Mensagem/template vazio.');

    const nome = cleanText(cliente.nome);
    const numero = cleanText(cliente.numero || cliente.telefoneOriginal || cliente.telefone || '');
    const valor = formatMoney(getDebtAmount(cliente)).replace(/^R\$\s?/, '');

    let mensagem = template
        .replace(/\{\{nome\}\}/g, nome)
        .replace(/\{\{primeiro_nome\}\}/g, firstName(nome))
        .replace(/\[cliente\]/g, nome)
        .replace(/\{\{valor\}\}/g, valor)
        .replace(/\{\{saldo_devedor\}\}/g, valor)
        .replace(/\{\{numero\}\}/g, numero || 'nao informado')
        .replace(/\{\{telefone\}\}/g, numero || 'nao informado')
        .replace(/\{\{cpf\}\}/g, cleanText(cliente.cpf || 'nao informado'))
        .replace(/\[0,00\]/g, valor);

    const hasAutomaticNotice = /mensagem autom(a|a)tica/i.test(mensagem.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    if (!hasAutomaticNotice) {
        mensagem = `Esta e uma mensagem automatica da Vale Verde. Se voce ja pagou ou regularizou, responda esta conversa com o comprovante ou com o ajuste necessario.\n\n${mensagem}`;
    }

    if (mostrarRodapeContato && !template.includes('{{numero}}') && !template.includes('{{telefone}}')) {
        mensagem += `\n\nCliente: ${nome || 'nao informado'}\nNumero: ${numero || 'nao informado'}\nValor: R$ ${valor}`;
    }

    return mensagem.trim();
}

module.exports = {
    montar: (cliente, templateFile = 'cobranca.txt', mostrarRodapeContato = true) => (
        formatMessage(cliente, resolveTemplate(templateFile), mostrarRodapeContato)
    ),
    montarComTexto: formatMessage,
};
