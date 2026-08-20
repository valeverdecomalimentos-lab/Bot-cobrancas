const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('valeverdeAPI', {
    bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
    importDataFile: () => ipcRenderer.invoke('data-import:select-file'),
    importDataFromUrl: (url) => ipcRenderer.invoke('data-import:from-url', { url }),
    removeConsumerBackupFolder: () => ipcRenderer.invoke('consumer-backup:remove-folder'),
    getConsumerBackupSyncStatus: () => ipcRenderer.invoke('consumer-backup:sync-status'),
    getConsumerCustomerProfile: (sourceKey, externalId) => ipcRenderer.invoke('consumer-profile:get', {
        sourceKey,
        externalId,
    }),
    listCustomers: () => ipcRenderer.invoke('customers:list'),
    listReports: () => ipcRenderer.invoke('reports:list'),
    getReport: (id) => ipcRenderer.invoke('reports:get', id),
    showReportInFolder: (fileName) => ipcRenderer.invoke('reports:show-in-folder', fileName),
    saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
    getAiStatus: () => ipcRenderer.invoke('ai:status'),
    saveAiSettings: (settings) => ipcRenderer.invoke('ai:settings-save', settings),
    removeAiCredential: (provider) => ipcRenderer.invoke('ai:credential-remove', provider),
    listTemplates: () => ipcRenderer.invoke('templates:list'),
    saveTemplate: (template) => ipcRenderer.invoke('templates:save', template),
    deleteTemplate: (id) => ipcRenderer.invoke('templates:delete', id),
    importTemplate: () => ipcRenderer.invoke('templates:import'),
    startWhatsapp: () => ipcRenderer.invoke('whatsapp:start'),
    getWhatsappStatus: () => ipcRenderer.invoke('whatsapp:status'),
    resetWhatsapp: () => ipcRenderer.invoke('whatsapp:reset'),
    importCampaignImage: () => ipcRenderer.invoke('campaign:image-import'),
    sendTest: (input) => ipcRenderer.invoke('campaign:test', input),
    startCampaign: (campaign) => ipcRenderer.invoke('campaign:start', campaign),
    pauseCampaign: (paused) => ipcRenderer.invoke('campaign:pause', paused),
    cancelCampaign: () => ipcRenderer.invoke('campaign:cancel'),
    getGeminiStatus: () => ipcRenderer.invoke('gemini:status'),
    generateExecutiveReport: () => ipcRenderer.invoke('gemini:executive-report'),
    askGemini: (input) => ipcRenderer.invoke('gemini:ask', input),
    diagnoseGemini: () => ipcRenderer.invoke('gemini:diagnose'),
    suggestCampaignMessage: (input) => ipcRenderer.invoke('gemini:suggest-campaign', input),
    clearGeminiHistory: () => ipcRenderer.invoke('gemini:clear-history'),
    onWhatsappStatus: (listener) => subscribe('whatsapp:status', listener),
    onConsumerBackupProgress: (listener) => subscribe('consumer-backup:progress', listener),
    onConsumerBackupSyncStatus: (listener) => subscribe('consumer-backup:sync-status', listener),
    onConsumerBackupDataUpdated: (listener) => subscribe('consumer-backup:data-updated', listener),
    onCampaignProgress: (listener) => subscribe('campaign:progress', listener),
    onCampaignFinished: (listener) => subscribe('campaign:finished', listener),
});
