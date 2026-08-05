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
};