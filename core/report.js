const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

function ordenarResultados(resultados) {
    const rank = {
        'Enviado': 1,
        'Enviado (teste)': 1,
        'Erro - Não tem WhatsApp': 2,
        'Erro de envio': 2,
        'Erro - conexão': 2,
        'Ignorado': 3,
        'Ignorado - Sem telefone válido': 3,
        'Ignorado - Não devedor': 3
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

module.exports = {
    gerar: async (resultados) => {
        const reportsDir = path.join(__dirname, '..', 'reports');
        if (!fs.existsSync(reportsDir)){
            fs.mkdirSync(reportsDir);
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Relatorio');

        worksheet.columns = [
            { header: 'Cliente', key: 'nome', width: 35 },
            { header: 'Telefone original', key: 'telefoneOriginal', width: 22 },
            { header: 'Telefone válido', key: 'telefoneValido', width: 22 },
            { header: 'Valor', key: 'valor', width: 15 },
            { header: 'Status original', key: 'status', width: 20 },
            { header: 'Status envio', key: 'statusEnvio', width: 25 }
        ];

        ordenarResultados(resultados).forEach(r => {
            worksheet.addRow({
                nome: r.nome,
                telefoneOriginal: r.telefoneOriginal || 'Sem telefone',
                telefoneValido: r.telefoneValido || 'Sem telefone',
                valor: r.valor,
                status: r.status,
                statusEnvio: r.statusEnvio
            });
        });

        worksheet.getRow(1).font = { bold: true };

        const fileName = `relatorio-${Date.now()}.xlsx`;
        const filePath = path.join(reportsDir, fileName);
        
        await workbook.xlsx.writeFile(filePath);
        return filePath;
    },
    gerarCSV: async (resultados) => {
        const reportsDir = path.join(__dirname, '..', 'reports');
        if (!fs.existsSync(reportsDir)){
            fs.mkdirSync(reportsDir);
        }

        const fileName = `relatorio-${Date.now()}.csv`;
        const filePath = path.join(reportsDir, fileName);

        const header = 'Cliente,TelefoneOriginal,TelefoneValido,Valor,StatusOriginal,StatusEnvio';
        const lines = [header];

        ordenarResultados(resultados).forEach(r => {
            const nome = safeText(r.nome);
            const telefoneOriginal = safeText(r.telefoneOriginal).replace('@c.us', '');
            const telefoneValido = safeText(r.telefoneValido).replace('@c.us', '');
            const valor = safeText(r.valor);
            const statusOriginal = safeText(r.status);
            const statusEnvio = safeText(r.statusEnvio);

            lines.push(`"${nome}","${telefoneOriginal}","${telefoneValido}","${valor}","${statusOriginal}","${statusEnvio}"`);
        });

        fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
        return filePath;
    },
    gerarTXT: async (resultados) => {
        const reportsDir = path.join(__dirname, '..', 'reports');
        if (!fs.existsSync(reportsDir)){
            fs.mkdirSync(reportsDir);
        }

        const ordered = ordenarResultados(resultados);
        const enviados = ordered.filter(r => String(r.statusEnvio || '').toLowerCase().startsWith('enviado'));
        const ignorados = ordered.filter(r => String(r.statusEnvio || '').toLowerCase().startsWith('ignorado'));
        const erros = ordered.filter(r => !String(r.statusEnvio || '').toLowerCase().startsWith('enviado') && !String(r.statusEnvio || '').toLowerCase().startsWith('ignorado'));

        const lines = [];
        lines.push(`Relatório de envio - ${new Date().toLocaleString()}`);
        lines.push('');
        lines.push(`Total de clientes: ${ordered.length}`);
        lines.push(`Enviados: ${enviados.length}`);
        lines.push(`Ignorados: ${ignorados.length}`);
        lines.push(`Erros: ${erros.length}`);
        lines.push('');

        if (enviados.length > 0) {
            lines.push('=== ENVIADOS ===');
            enviados.forEach(r => {
                lines.push(`- ${safeText(r.nome)} | ${safeText(r.telefoneOriginal || r.telefoneValido)} | R$ ${safeText(r.valor)} | ${safeText(r.status || 'Devedor')}`);
            });
            lines.push('');
        }

        if (ignorados.length > 0) {
            lines.push('=== IGNORADOS ===');
            ignorados.forEach(r => {
                lines.push(`- ${safeText(r.nome)} | ${safeText(r.telefoneOriginal || r.telefoneValido)} | R$ ${safeText(r.valor)} | ${safeText(r.statusEnvio)}`);
            });
            lines.push('');
        }

        if (erros.length > 0) {
            lines.push('=== ERROS ===');
            erros.forEach(r => {
                lines.push(`- ${safeText(r.nome)} | ${safeText(r.telefoneOriginal || r.telefoneValido)} | R$ ${safeText(r.valor)} | ${safeText(r.statusEnvio)}`);
            });
            lines.push('');
        }

        const fileName = `relatorio-${Date.now()}.txt`;
        const filePath = path.join(reportsDir, fileName);
        fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
        return filePath;
    }
};