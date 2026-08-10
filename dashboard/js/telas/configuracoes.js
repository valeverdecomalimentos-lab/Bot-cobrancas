import { estado } from '../nucleo/estado.js';
import { paraElemento, abrirModal, mostrarToast, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

export function montarConfiguracoes(alvo) {
  const somenteAdmin = estado.usuarioAtual.papel === 'admin';
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina"><div><h1>Configurações</h1><p class="legenda">Ajustes gerais do disparo e da conta</p></div></div>

      <div class="grade-config">
        <div>
          <div class="cartao secao-config">
            <h3>${Icone.cifrao} Chave PIX para cobrança</h3>
            <div class="campo">
              <label for="campo-pix">Chave</label>
              <input type="text" id="campo-pix" value="${escaparHtml(estado.config.chavePix)}" ${somenteAdmin ? '' : 'disabled'}>
            </div>
            ${somenteAdmin ? '<button class="btn btn--primario" id="btn-salvar-pix">Salvar chave</button>' : '<p style="font-size:12.5px;color:var(--vv-texto-sutil)">Apenas administradores podem alterar.</p>'}
          </div>

          <div class="cartao secao-config">
            <h3>${Icone.relogio} Intervalo entre mensagens</h3>
            <div class="campo">
              <label>Mínimo: <span id="rotulo-min">${estado.config.intervaloMin}s</span></label>
              <div class="slider-wrap"><input type="range" id="slider-min" min="3" max="15" value="${estado.config.intervaloMin}" ${somenteAdmin ? '' : 'disabled'}></div>
            </div>
            <div class="campo">
              <label>Máximo: <span id="rotulo-max">${estado.config.intervaloMax}s</span></label>
              <div class="slider-wrap"><input type="range" id="slider-max" min="5" max="30" value="${estado.config.intervaloMax}" ${somenteAdmin ? '' : 'disabled'}></div>
            </div>
            <p style="font-size:12.5px;color:var(--vv-texto-sutil)">Intervalo aleatório entre cada mensagem para reduzir o risco de bloqueio do número.</p>
          </div>
        </div>

        <div>
          <div class="cartao secao-config">
            <h3>${Icone.editar} Templates salvos</h3>
            <div id="lista-templates"></div>
            ${somenteAdmin ? '<button class="btn btn--secundario" id="btn-novo-template" style="margin-top:6px">+ Novo template</button>' : ''}
          </div>

          ${somenteAdmin ? `
          <div class="cartao secao-config">
            <h3>${Icone.usuario} Usuários</h3>
            <div id="lista-usuarios"></div>
          </div>` : ''}
        </div>
      </div>
    </div>`);
  alvo.appendChild(tela);

  if (somenteAdmin) {
    tela.querySelector('#btn-salvar-pix').addEventListener('click', () => {
      estado.config.chavePix = tela.querySelector('#campo-pix').value;
      mostrarToast('Chave PIX atualizada');
    });
    const sMin = tela.querySelector('#slider-min'), sMax = tela.querySelector('#slider-max');
    sMin.addEventListener('input', () => { tela.querySelector('#rotulo-min').textContent = sMin.value + 's'; });
    sMax.addEventListener('input', () => { tela.querySelector('#rotulo-max').textContent = sMax.value + 's'; });
    [sMin, sMax].forEach((s) => s.addEventListener('change', () => {
      estado.config.intervaloMin = Number(sMin.value);
      estado.config.intervaloMax = Number(sMax.value);
      mostrarToast('Intervalo de envio atualizado');
    }));
    tela.querySelector('#btn-novo-template').addEventListener('click', () => abrirEditorTemplate(renderizarTemplates));
  }

  const listaTemplates = tela.querySelector('#lista-templates');
  function renderizarTemplates() {
    listaTemplates.innerHTML = estado.config.templates.map((t) => `
      <div class="linha-template">
        <span>${escaparHtml(t.nome)}</span>
        ${somenteAdmin ? `<span style="display:flex;gap:4px">
          <button class="btn btn--fantasma" data-editar="${t.id}" aria-label="Editar">${Icone.editar}</button>
          <button class="btn btn--fantasma" data-excluir="${t.id}" aria-label="Excluir">${Icone.lixeira}</button>
        </span>` : ''}
      </div>`).join('');
  }
  renderizarTemplates();
  listaTemplates.addEventListener('click', (e) => {
    const editar = e.target.closest('[data-editar]');
    const excluir = e.target.closest('[data-excluir]');
    if (editar) abrirEditorTemplate(renderizarTemplates, estado.config.templates.find((t) => t.id == editar.dataset.editar));
    if (excluir) {
      estado.config.templates = estado.config.templates.filter((t) => t.id != excluir.dataset.excluir);
      renderizarTemplates();
      mostrarToast('Template excluído', 'aviso');
    }
  });

  if (somenteAdmin) {
    const listaUsuarios = tela.querySelector('#lista-usuarios');
    listaUsuarios.innerHTML = estado.config.usuarios.map((u) => `
      <div class="linha-usuario">
        <span><strong>${escaparHtml(u.nome)}</strong><br><small style="color:var(--vv-texto-sutil)">${escaparHtml(u.email)}</small></span>
        <span class="pill-papel ${u.papel}">${u.papel === 'admin' ? 'Admin' : 'Operador'}</span>
      </div>`).join('');
  }
}

function abrirEditorTemplate(aoSalvar, templateExistente) {
  const { elemento, fechar } = abrirModal({
    titulo: templateExistente ? 'Editar template' : 'Novo template',
    corpoHtml: `
      <div class="campo"><label for="nome-tpl">Nome</label><input type="text" id="nome-tpl" value="${escaparHtml(templateExistente?.nome ?? '')}"></div>
      <div class="campo"><label for="texto-tpl">Mensagem</label><textarea id="texto-tpl" rows="5">${escaparHtml(templateExistente?.texto ?? '')}</textarea></div>
    `,
    rodapeHtml: `<button class="btn btn--secundario" data-cancelar>Cancelar</button><button class="btn btn--primario" data-salvar>Salvar</button>`,
  });
  elemento.querySelector('[data-cancelar]').addEventListener('click', fechar);
  elemento.querySelector('[data-salvar]').addEventListener('click', () => {
    const nome = elemento.querySelector('#nome-tpl').value.trim();
    const texto = elemento.querySelector('#texto-tpl').value.trim();
    if (!nome || !texto) return mostrarToast('Preencha nome e mensagem', 'erro');
    if (templateExistente) { templateExistente.nome = nome; templateExistente.texto = texto; }
    else estado.config.templates.push({ id: Date.now(), nome, texto });
    fechar();
    aoSalvar();
    mostrarToast('Template salvo');
  });
}
