const fs = require('fs');
const path = require('path');
const { cleanText, slugify } = require('./customer-utils');

const BUNDLED_TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const TEMPLATES_DIR = process.env.VALEVERDE_TEMPLATES_DIR || BUNDLED_TEMPLATES_DIR;

function ensureTemplatesDir() {
    if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    if (TEMPLATES_DIR === BUNDLED_TEMPLATES_DIR || !fs.existsSync(BUNDLED_TEMPLATES_DIR)) return;
    const hasTemplates = fs.readdirSync(TEMPLATES_DIR).some((name) => name.toLowerCase().endsWith('.txt'));
    if (hasTemplates) return;
    fs.readdirSync(BUNDLED_TEMPLATES_DIR)
        .filter((name) => name.toLowerCase().endsWith('.txt'))
        .forEach((name) => fs.copyFileSync(path.join(BUNDLED_TEMPLATES_DIR, name), path.join(TEMPLATES_DIR, name)));
}

function titleFromFile(fileName) {
    return path.basename(fileName, '.txt')
        .split(/[-_]/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function listTemplates() {
    ensureTemplatesDir();
    return fs.readdirSync(TEMPLATES_DIR)
        .filter((name) => name.toLowerCase().endsWith('.txt'))
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((name) => ({
            id: path.basename(name, '.txt'),
            nome: titleFromFile(name),
            arquivo: name,
            texto: fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8').trim(),
        }));
}

function getTemplateByFile(fileName) {
    ensureTemplatesDir();
    const safeName = path.basename(fileName || '');
    const filePath = path.join(TEMPLATES_DIR, safeName);
    if (!safeName || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
}

function saveTemplate(template) {
    ensureTemplatesDir();
    const name = cleanText(template.nome || template.id || 'template');
    const id = slugify(template.id || name || `template-${Date.now()}`) || `template-${Date.now()}`;
    const fileName = `${id}.txt`;
    const text = String(template.texto || '').trim();

    if (!text) {
        throw new Error('Template vazio nao pode ser salvo.');
    }

    fs.writeFileSync(path.join(TEMPLATES_DIR, fileName), text, 'utf8');
    return { id, nome: name, arquivo: fileName, texto: text };
}

function deleteTemplate(id) {
    ensureTemplatesDir();
    const safeId = slugify(id);
    if (!safeId) return false;
    const filePath = path.join(TEMPLATES_DIR, `${safeId}.txt`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
}

module.exports = {
    listTemplates,
    getTemplateByFile,
    saveTemplate,
    deleteTemplate,
};
