const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

function reportsDirectory() {
    const reportsDir = process.env.VALEVERDE_REPORTS_DIR || path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    return reportsDir;
}

function ordenarResultados(resultados) {
    const rank = {
        Enviado: 1,
        'Enviado (teste)': 1,
        'Erro - Nao tem WhatsApp': 2,
        'Erro de envio': 2,
        'Erro - conexao': 2,
        Ignorado: 3,
        'Ignorado - Sem telefone valido': 3,
        'Ignorado - Nao devedor': 3,
    };
    return [...resultados].sort((a, b) => {
        const aRank = rank[a.statusEnvio] || 4;
        const bRank = rank[b.statusEnvio] || 4;
        if (aRank !== bRank) return aRank - bRank;
        return String(a.nome || '').localeCompare(String(b.nome || ''));
    });
}

function safeText(value) {
    return String(value || '').replace(/\r?\n/g, ' ').replace(/"/g, '""').trim();
}

function orderedRows(resultados) {
    return ordenarResultados(resultados).map((result) => ({
        Cliente: result.nome,
        'Telefone original': result.telefoneOriginal || 'Sem telefone',
        'Telefone valido': result.telefoneValido || 'Sem telefone',
        Valor: result.valor,
        'Status original': result.status,
        'Status envio': result.statusEnvio,
    }));
}

module.exports = {
    gerar: async (resultados) => {
        const reportsDir = reportsDirectory();
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(orderedRows(resultados), {
            header: ['Cliente', 'Telefone original', 'Telefone valido', 'Valor', 'Status original', 'Status envio'],
        });
        worksheet['!cols'] = [{ wch: 35 }, { wch: 22 }, { wch: 22 }, { wch: 15 }, { wch: 20 }, { wch: 25 }];
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Relatorio');

        const fileName = `relatorio-${Date.now()}.xlsx`;
        const filePath = path.join(reportsDir, fileName);
        XLSX.writeFile(workbook, filePath, { compression: true });
        return filePath;
    },
    gerarCSV: async (resultados) => {
        const reportsDir = reportsDirectory();
        const fileName = `relatorio-${Date.now()}.csv`;
        const filePath = path.join(reportsDir, fileName);
        const header = 'Cliente,TelefoneOriginal,TelefoneValido,Valor,StatusOriginal,StatusEnvio';
        const lines = [header];

        ordenarResultados(resultados).forEach((result) => {
            lines.push([
                safeText(result.nome),
                safeText(result.telefoneOriginal).replace('@c.us', ''),
                safeText(result.telefoneValido).replace('@c.us', ''),
                safeText(result.valor),
                safeText(result.status),
                safeText(result.statusEnvio),
            ].map((value) => `"${value}"`).join(','));
        });
        fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
        return filePath;
    },
    gerarTXT: async (resultados) => {
        const reportsDir = reportsDirectory();
        const ordered = ordenarResultados(resultados);
        const enviados = ordered.filter((item) => String(item.statusEnvio || '').toLowerCase().startsWith('enviado'));
        const ignorados = ordered.filter((item) => String(item.statusEnvio || '').toLowerCase().startsWith('ignorado'));
        const erros = ordered.filter((item) => !String(item.statusEnvio || '').toLowerCase().startsWith('enviado') && !String(item.statusEnvio || '').toLowerCase().startsWith('ignorado'));
        const lines = [
            `Relatorio de envio - ${new Date().toLocaleString('pt-BR')}`,
            '',
            `Total de clientes: ${ordered.length}`,
            `Enviados: ${enviados.length}`,
            `Ignorados: ${ignorados.length}`,
            `Erros: ${erros.length}`,
            '',
        ];
        const appendSection = (title, items) => {
            if (!items.length) return;
            lines.push(`=== ${title} ===`);
            items.forEach((item) => {
                lines.push(`- ${safeText(item.nome)} | ${safeText(item.telefoneOriginal || item.telefoneValido)} | R$ ${safeText(item.valor)} | ${safeText(item.statusEnvio || item.status || '')}`);
            });
            lines.push('');
        };
        appendSection('ENVIADOS', enviados);
        appendSection('IGNORADOS', ignorados);
        appendSection('ERROS', erros);

        const fileName = `relatorio-${Date.now()}.txt`;
        const filePath = path.join(reportsDir, fileName);
        fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
        return filePath;
    },
};
