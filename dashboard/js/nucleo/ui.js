export const escaparHtml = (valor) => String(valor ?? '').replace(/[&<>"']/g, (caractere) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[caractere]));

export function paraElemento(html) {
  const modelo = document.createElement('template');
  modelo.innerHTML = String(html || '').trim();
  return modelo.content.firstElementChild;
}

export function mostrarToast(texto, tipo = 'sucesso') {
  document.querySelectorAll('.toast').forEach((toast) => toast.remove());
  const simbolos = { sucesso: 'OK', erro: '!', aviso: '!' };
  const toast = document.createElement('div');
  toast.className = `toast toast--${tipo}`;
  toast.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
  toast.setAttribute('aria-live', tipo === 'erro' ? 'assertive' : 'polite');

  const icone = document.createElement('span');
  icone.className = 'toast__icone';
  icone.setAttribute('aria-hidden', 'true');
  icone.textContent = simbolos[tipo] || 'OK';

  const mensagem = document.createElement('span');
  mensagem.textContent = String(texto || '');
  toast.append(icone, mensagem);
  document.body.appendChild(toast);

  const remover = () => {
    toast.classList.add('toast--saindo');
    setTimeout(() => toast.remove(), 180);
  };
  setTimeout(remover, tipo === 'erro' ? 5200 : 3600);
  return remover;
}

export function abrirModal({ titulo, corpoHtml, rodapeHtml = '' }) {
  const focoAnterior = document.activeElement;
  const idTitulo = `modal-titulo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const overlay = paraElemento(`
    <div class="sobreposicao">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${idTitulo}" tabindex="-1">
        <div class="modal-cabecalho"><h3 id="${idTitulo}">${escaparHtml(titulo)}</h3>
          <button class="btn btn--fantasma" type="button" data-fechar aria-label="Fechar dialogo">&times;</button>
        </div>
        <div class="modal-corpo">${corpoHtml}</div>
        ${rodapeHtml ? `<div class="modal-rodape">${rodapeHtml}</div>` : ''}
      </div>
    </div>`);

  const modal = overlay.querySelector('.modal');
  let fechado = false;
  const elementosFocaveis = () => [...modal.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((elemento) => !elemento.hidden && elemento.offsetParent !== null);

  const fechar = () => {
    if (fechado) return;
    fechado = true;
    document.removeEventListener('keydown', aoPressionarTecla, true);
    overlay.remove();
    if (focoAnterior instanceof HTMLElement && focoAnterior.isConnected) focoAnterior.focus();
  };

  function aoPressionarTecla(evento) {
    if (evento.key === 'Escape') {
      evento.preventDefault();
      fechar();
      return;
    }
    if (evento.key !== 'Tab') return;
    const itens = elementosFocaveis();
    if (!itens.length) {
      evento.preventDefault();
      modal.focus();
      return;
    }
    const primeiro = itens[0];
    const ultimo = itens[itens.length - 1];
    if (evento.shiftKey && document.activeElement === primeiro) {
      evento.preventDefault();
      ultimo.focus();
    } else if (!evento.shiftKey && document.activeElement === ultimo) {
      evento.preventDefault();
      primeiro.focus();
    }
  }

  overlay.addEventListener('click', (evento) => { if (evento.target === overlay) fechar(); });
  overlay.querySelector('[data-fechar]').addEventListener('click', fechar);
  document.addEventListener('keydown', aoPressionarTecla, true);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => (elementosFocaveis()[0] || modal).focus());
  return { elemento: overlay, fechar };
}
