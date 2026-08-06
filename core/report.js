const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

module.exports = {
    gerar: async (resultados) => {
        const reportsDir = path.join(__dirname, '..', 'reports');
        if (!fs.existsSync(reportsDir)){
            fs.mkdirSync(reportsDir);
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Relatorio');

        worksheet.columns = [
            { header: 'Cliente', key: 'nome', width: 30 },
            { header: 'Telefone', key: 'telefoneOriginal', width: 20 },
            { header: 'Valor', key: 'valor', width: 15 },
            { header: 'Status Original', key: 'status', width: 15 },
            { header: 'Status Envio', key: 'statusEnvio', width: 25 }
        ];

        resultados.forEach(r => {
            worksheet.addRow({
                nome: r.nome,
                telefoneOriginal: r.telefoneOriginal || 'Sem telefone',
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
    }
    , gerarCSV: async (resultados) => {
        const reportsDir = path.join(__dirname, '..', 'reports');
        if (!fs.existsSync(reportsDir)){
            fs.mkdirSync(reportsDir);
        }

        const fileName = `relatorio-${Date.now()}.csv`;
        const filePath = path.join(reportsDir, fileName);

        const header = 'Cliente,Numero,Valor,StatusEnvio';
        const lines = [header];

        resultados.forEach(r => {
            // numero: prefer telefoneOriginal (raw), se não existir usa telefoneValido (sem @c.us)
            let numero = '';
            if (r.telefoneOriginal) numero = String(r.telefoneOriginal).replace(/\r?\n/g,' ').trim();
            else if (r.telefoneValido) numero = String(r.telefoneValido).replace('@c.us','').trim();

            const valor = r.valor !== undefined ? String(r.valor) : '';
            const nome = String(r.nome).replace(/[,\r\n]/g,' ').trim();
            const status = String(r.statusEnvio || '');

            lines.push(`${nome},${numero},${valor},${status}`);
        });

        fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
        return filePath;
    }
};