const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('valeverdeAPI', {
    bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
    syncLists: () => ipcRenderer.invoke('lists:sync'),
    importCustomers: () => ipcRenderer.invoke('customers:import'),
    listCustomers: () => ipcRenderer.invoke('customers:list'),
    listReports: () => ipcRenderer.invoke('reports:list'),
    getReport: (id) => ipcRenderer.invoke('reports:get', id),
    showReportInFolder: (fileName) => ipcRenderer.invoke('reports:show-in-folder', fileName),
    saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
    listTemplates: () => ipcRenderer.invoke('templates:list'),
    saveTemplate: (template) => ipcRenderer.invoke('templates:save', template),
    deleteTemplate: (id) => ipcRenderer.invoke('templates:delete', id),
    importTemplate: () => ipcRenderer.invoke('templates:import'),
    startWhatsapp: () => ipcRenderer.invoke('whatsapp:start'),
    getWhatsappStatus: () => ipcRenderer.invoke('whatsapp:status'),
    sendTest: (input) => ipcRenderer.invoke('campaign:test', input),
    startCampaign: (campaign) => ipcRenderer.invoke('campaign:start', campaign),
    pauseCampaign: (paused) => ipcRenderer.invoke('campaign:pause', paused),
    cancelCampaign: () => ipcRenderer.invoke('campaign:cancel'),
    getGeminiStatus: () => ipcRenderer.invoke('gemini:status'),
    generateExecutiveReport: () => ipcRenderer.invoke('gemini:executive-report'),
    askGemini: (input) => ipcRenderer.invoke('gemini:ask', input),
    diagnoseGemini: () => ipcRenderer.invoke('gemini:diagnose'),
    suggestCampaignMessage: (input) => ipcRenderer.invoke('gemini:suggest-campaign', input),
    onWhatsappStatus: (listener) => subscribe('whatsapp:status', listener),
    onCampaignProgress: (listener) => subscribe('campaign:progress', listener),
    onCampaignFinished: (listener) => subscribe('campaign:finished', listener),
});
