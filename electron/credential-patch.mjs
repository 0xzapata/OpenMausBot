// What saving a credential from the desktop changes in the server config, by credential name.
export const CREDENTIAL_PATCH = {
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  opencodeGoApiKey: (value) => ({ opencodeGo: { apiKey: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  fishAudioKey: (value) => ({ tts: { fishKey: value } }),
  jevApiKey: (value) => ({ decider: { key: value } }),
  openrouterDeciderKey: (value) => ({ decider: { openrouterKey: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
  customImageApiKey: (value) => ({ imageGen: { customApiKey: value } }),
  openaiLiveKey: (value) => ({ live: { key: value } }),
};
