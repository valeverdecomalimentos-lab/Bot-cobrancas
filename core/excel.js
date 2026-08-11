const { normalizeCustomer, upsertCustomers } = require('./customer-utils');
const { readSpreadsheetRows } = require('./spreadsheet');

function normalizeRows(rows, source = '') {
    const normalized = rows
        .map((row) => normalizeCustomer(row, { source, keepRaw: true }))
        .filter(Boolean);
    return upsertCustomers([], normalized, { source, keepRaw: true }).customers;
}

module.exports = {
    lerPlanilha: async (filePath) => normalizeRows(await readSpreadsheetRows(filePath), filePath),
    lerLinhas: readSpreadsheetRows,
    normalizarLinhas: normalizeRows,
};
