import { estado } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { paraElemento, abrirModal, mostrarToast, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

export function montarConfiguracoes(alvo) {
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina"><div><h1>Configuracoes</h1><p class="legenda">Preferencias persistidas para os proximos disparos.</p></div></div>
      <div class="grade-config">
        <div>
          <div class="cartao secao-config">
            <h3>${Icone.cifrao} Chave PIX</h3>
            <div class="campo"><label for="campo-pix">Chave</label><input type="text" id="campo-pix" value="${escaparHtml(estado.config.chavePix)}"></div>
            <button class="btn btn--primario" id="btn-salvar-config">Salvar configuracoes</button>
          </div>
          <div class="cartao secao-config">
            <h3>${Icone.relogio} Intervalo entre mensagens</h3>
            <div class="campo"><label for="slider-min">Minimo: <span id="rotulo-min">${estado.config.intervaloMin}s</span></label><div class="slider-wrap"><input type="range" id="slider-min" min="3" max="60" value="${estado.config.intervaloMin}"></div></div>
            <div class="campo"><label for="slider-max">Maximo: <span id="rotulo-max">${estado.config.intervaloMax}s</span></label><div class="slider-wrap"><input type="range" id="slider-max" min="3" max="120" value="${estado.config.intervaloMax}"></div></div>
          </div>
        </div>
        <div><div class="cartao secao-config"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><h3>${Icone.editar} Templates salvos</h3><div style="display:flex;gap:6px"><button class="btn btn--fantasma" id="btn-importar-template" title="Importar template TXT">${Icone.upload}</button><button class="btn btn--fantasma" id="btn-novo-template" title="Novo template">${Icone.adicionar}</button></div></div><div id="lista-templates"></div></div></div>
      </div>
    </div>`);
  alvo.appendChild(tela);
  const campoPix = tela.querySelector('#campo-pix');
  const sliderMin = tela.querySelector('#slider-min');
  const sliderMax = tela.querySelector('#slider-max');

  function atualizarRotulos() {
    const min = Number(sliderMin.value);
    const max = Math.max(Number(sliderMax.value), min);
    sliderMax.value = max;
    tela.querySelector('#rotulo-min').textContent = `${min}s`;
    tela.querySelector('#rotulo-max').textContent = `${max}s`;
  }

  sliderMin.addEventListener('input', atualizarRotulos);
  sliderMax.addEventListener('input', atualizarRotulos);
  tela.querySelector('#btn-salvar-config').addEventListener('click', async () => {
    try {
      estado.config = { ...estado.config, ...await api.saveSettings({ chavePix: campoPix.value, intervaloMin: Number(sliderMin.value), intervaloMax: Number(sliderMax.value) }) };
      mostrarToast('Configuracoes salvas', 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel salvar as configuracoes.', 'erro');
    }
  });

  const listaTemplates = tela.querySelector('#lista-templates');
  async function atualizarTemplates() {
    estado.config.templates = await api.listTemplates();
    renderizarTemplates();
  }
  function renderizarTemplates() {
    if (!estado.config.templates.length) {
      listaTemplates.innerHTML = '<div class="estado-vazio" style="padding:24px 10px"><p>Nenhum template salvo.</p></div>';
      return;
    }
    listaTemplates.innerHTML = estado.config.templates.map((template) => `
      <div class="linha-template"><span>${escaparHtml(template.nome)}</span><span style="display:flex;gap:4px"><button class="btn btn--fantasma" data-editar="${escaparHtml(template.id)}" title="Editar">${Icone.editar}</button><button class="btn btn--fantasma" data-excluir="${escaparHtml(template.id)}" title="Excluir">${Icone.lixeira}</button></span></div>`).join('');
  }
  renderizarTemplates();
  tela.querySelector('#btn-novo-template').addEventListener('click', () => abrirEditorTemplate(atualizarTemplates));
  tela.querySelector('#btn-importar-template').addEventListener('click', async () => {
    try {
      const resultado = await api.importTemplate();
      if (resultado.cancelado) return;
      await atualizarTemplates();
      mostrarToast('Template importado', 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel importar o template.', 'erro');
    }
  });
  listaTemplates.addEventListener('click', async (event) => {
    const editar = event.target.closest('[data-editar]');
    const excluir = event.target.closest('[data-excluir]');
    if (editar) {
      const template = estado.config.templates.find((item) => String(item.id) === String(editar.dataset.editar));
      abrirEditorTemplate(atualizarTemplates, template);
    }
    if (excluir) {
      try {
        await api.deleteTemplate(excluir.dataset.excluir);
        await atualizarTemplates();
        mostrarToast('Template excluido', 'aviso');
      } catch (error) {
        mostrarToast(error.message || 'Nao foi possivel excluir o template.', 'erro');
      }
    }
  });
}

function abrirEditorTemplate(aoSalvar, templateExistente) {
  const { elemento, fechar } = abrirModal({
    titulo: templateExistente ? 'Editar template' : 'Novo template',
    corpoHtml: `<div class="campo"><label for="nome-tpl">Nome</label><input type="text" id="nome-tpl" value="${escaparHtml(templateExistente?.nome)}"></div><div class="campo"><label for="texto-tpl">Mensagem</label><textarea id="texto-tpl" rows="7">${escaparHtml(templateExistente?.texto)}</textarea></div>`,
    rodapeHtml: '<button class="btn btn--secundario" data-cancelar>Cancelar</button><button class="btn btn--primario" data-salvar>Salvar</button>',
  });
  elemento.querySelector('[data-cancelar]').addEventListener('click', fechar);
  elemento.querySelector('[data-salvar]').addEventListener('click', async () => {
    const nome = elemento.querySelector('#nome-tpl').value.trim();
    const texto = elemento.querySelector('#texto-tpl').value.trim();
    if (!nome || !texto) return mostrarToast('Preencha nome e mensagem.', 'erro');
    try {
      await api.saveTemplate({ id: templateExistente?.id, nome, texto });
      await aoSalvar();
      fechar();
      mostrarToast('Template salvo', 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel salvar o template.', 'erro');
    }
  });
}
