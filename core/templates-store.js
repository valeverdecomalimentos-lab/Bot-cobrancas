const fs = require('fs');
const path = require('path');
const { cleanText, slugify } = require('./customer-utils');

const BUNDLED_TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const TEMPLATES_DIR = process.env.VALEVERDE_TEMPLATES_DIR || BUNDLED_TEMPLATES_DIR;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const LEGACY_PIX_KEY = '22998628769';
const LEGACY_PIX_BENEFICIARY = 'Israel Felipe de Oliveira Donadio';

function migrateLegacyPixTemplate() {
    if (TEMPLATES_DIR === BUNDLED_TEMPLATES_DIR) return;
    const filePath = path.join(TEMPLATES_DIR, 'cobranca.txt');
    if (!fs.existsSync(filePath)) return;

    const current = fs.readFileSync(filePath, 'utf8');
    if (/\{\{(?:pix_chave|chave_pix)\}\}/i.test(current)) return;

    const keyPattern = new RegExp(`Chave PIX:\\s*${LEGACY_PIX_KEY}`, 'i');
    const beneficiaryPattern = new RegExp(`Favorecido:\\s*${LEGACY_PIX_BENEFICIARY}`, 'i');
    if (!keyPattern.test(current) || !beneficiaryPattern.test(current)) return;

    const migrated = current
        .replace(keyPattern, 'Tipo de chave: {{pix_tipo}}\n\nChave PIX: {{pix_chave}}')
        .replace(beneficiaryPattern, 'Favorecido: {{pix_nome_favorecido}}');
    const backupPath = `${filePath}.pre-pix-placeholders.bak`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, migrated, 'utf8');
}

function ensureTemplatesDir() {
    if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    if (TEMPLATES_DIR === BUNDLED_TEMPLATES_DIR || !fs.existsSync(BUNDLED_TEMPLATES_DIR)) return;
    const hasTemplates = fs.readdirSync(TEMPLATES_DIR).some((name) => name.toLowerCase().endsWith('.txt'));
    if (!hasTemplates) {
        fs.readdirSync(BUNDLED_TEMPLATES_DIR)
            .filter((name) => name.toLowerCase().endsWith('.txt'))
            .forEach((name) => fs.copyFileSync(path.join(BUNDLED_TEMPLATES_DIR, name), path.join(TEMPLATES_DIR, name)));
    }
    migrateLegacyPixTemplate();
}

function titleFromFile(fileName) {
    return path.basename(fileName, '.txt')
        .split(/[-_]/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function findTemplateImagePath(id) {
    ensureTemplatesDir();
    const safeId = path.basename(String(id || '').replace(/\.txt$/i, ''));
    if (!safeId) return null;
    for (const extension of IMAGE_EXTENSIONS) {
        const filePath = path.join(TEMPLATES_DIR, `${safeId}${extension}`);
        if (fs.existsSync(filePath)) return filePath;
    }
    return null;
}

function templateImageMetadata(id) {
    const filePath = findTemplateImagePath(id);
    if (!filePath) return null;
    const stats = fs.statSync(filePath);
    return {
        arquivo: path.basename(filePath),
        extensao: path.extname(filePath).slice(1).toLowerCase(),
        tamanho: stats.size,
    };
}

function listTemplates() {
    ensureTemplatesDir();
    return fs.readdirSync(TEMPLATES_DIR)
        .filter((name) => name.toLowerCase().endsWith('.txt'))
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((name) => {
            const id = path.basename(name, '.txt');
            return {
                id,
                nome: titleFromFile(name),
                arquivo: name,
                texto: fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8').trim(),
                imagem: templateImageMetadata(id),
            };
        });
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
    IMAGE_EXTENSIONS,
    listTemplates,
    getTemplateByFile,
    saveTemplate,
    deleteTemplate,
    findTemplateImagePath,
};
