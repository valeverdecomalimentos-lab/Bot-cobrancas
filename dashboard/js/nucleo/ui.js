export function paraElemento(html) {
  const modelo = document.createElement('template');
  modelo.innerHTML = html.trim();
  return modelo.content.firstElementChild;
}

export function mostrarToast(texto, tipo = 'sucesso') {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const icone = { sucesso: '✔', erro: '✕', aviso: '⚠' }[tipo] ?? '✔';
  const toast = paraElemento(`<div class="toast"><span>${icone}</span><span>${texto}</span></div>`);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

export function abrirModal({ titulo, corpoHtml, rodapeHtml = '' }) {
  const overlay = paraElemento(`
    <div class="sobreposicao">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${titulo}">
        <div class="modal-cabecalho"><h3>${titulo}</h3>
          <button class="btn btn--fantasma" data-fechar aria-label="Fechar">✕</button>
        </div>
        <div class="modal-corpo">${corpoHtml}</div>
        ${rodapeHtml ? `<div class="modal-rodape">${rodapeHtml}</div>` : ''}
      </div>
    </div>`);
  const fechar = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) fechar(); });
  overlay.querySelector('[data-fechar]').addEventListener('click', fechar);
  document.body.appendChild(overlay);
  return { elemento: overlay, fechar };
}

export const escaparHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
