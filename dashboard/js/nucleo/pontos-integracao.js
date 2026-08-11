function indisponivel() {
  return Promise.reject(new Error('Abra o painel pelo aplicativo Electron para acessar os recursos locais.'));
}

const bridge = typeof window !== 'undefined' ? window.valeverdeAPI : null;

export const api = bridge || {
  bootstrap: indisponivel,
  syncLists: indisponivel,
  importCustomers: indisponivel,
  listCustomers: indisponivel,
  listReports: indisponivel,
  getReport: indisponivel,
  showReportInFolder: indisponivel,
  saveSettings: indisponivel,
  listTemplates: indisponivel,
  saveTemplate: indisponivel,
  deleteTemplate: indisponivel,
  importTemplate: indisponivel,
  startWhatsapp: indisponivel,
  getWhatsappStatus: indisponivel,
  sendTest: indisponivel,
  startCampaign: indisponivel,
  pauseCampaign: indisponivel,
  cancelCampaign: indisponivel,
  getGeminiStatus: indisponivel,
  generateExecutiveReport: indisponivel,
  askGemini: indisponivel,
  diagnoseGemini: indisponivel,
  suggestCampaignMessage: indisponivel,
  onWhatsappStatus: () => () => {},
  onCampaignProgress: () => () => {},
  onCampaignFinished: () => () => {},
};
