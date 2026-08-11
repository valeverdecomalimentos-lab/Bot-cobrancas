import { marked } from '../../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../../node_modules/dompurify/dist/purify.es.mjs';

marked.setOptions({
  gfm: true,
  breaks: true,
});

const PROTOCOLOS_SEGUROS = new Set(['http:', 'https:', 'mailto:']);

export function renderizarMarkdown(conteudo) {
  const markdown = String(conteudo || '').trim();
  if (!markdown) return '';

  const html = marked.parse(markdown, { async: false });
  const limpo = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'autofocus', 'id'],
    ALLOW_DATA_ATTR: false,
  });

  const modelo = document.createElement('template');
  modelo.innerHTML = limpo;
  modelo.content.querySelectorAll('a').forEach((link) => {
    const href = link.getAttribute('href') || '';
    try {
      const url = new URL(href);
      if (!PROTOCOLOS_SEGUROS.has(url.protocol)) throw new Error('Protocolo nao permitido');
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } catch {
      link.removeAttribute('href');
      link.removeAttribute('target');
      link.removeAttribute('rel');
    }
  });
  return modelo.innerHTML;
}

export function textoDaResposta(resposta) {
  if (typeof resposta === 'string') return resposta;
  return String(resposta?.texto ?? resposta?.text ?? resposta?.resposta ?? '');
}

export function metadadosDaResposta(resposta) {
  if (!resposta || typeof resposta !== 'object') return {};
  const base = resposta.metadados && typeof resposta.metadados === 'object'
    ? resposta.metadados
    : {
        finishReason: resposta.finishReason,
        continuacoes: resposta.continuacoes ?? resposta.continuationCount,
        cache: resposta.cache,
      };
  return {
    ...base,
    acoes: Array.isArray(resposta.preparedActions) ? resposta.preparedActions : [],
    contexto: resposta.context && typeof resposta.context === 'object' ? resposta.context : undefined,
  };
}
