// Roteador minimalista por hash. Uma única função de callback recebe o nome
// da rota corrente; quem chama decide como montar cada tela (ver app.js).

export function navegar(nome) {
  window.location.hash = nome;
}

export function nomeRotaAtual() {
  return (window.location.hash || '#login').slice(1);
}

export function iniciarRoteador(aoTrocarRota) {
  const resolver = () => aoTrocarRota(nomeRotaAtual());
  window.addEventListener('hashchange', resolver);
  resolver();
}
