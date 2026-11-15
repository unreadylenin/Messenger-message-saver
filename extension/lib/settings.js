// Shared settings for the background worker, popup and dashboard.
// The content script keeps an identical copy of DEFAULT_SETTINGS (it cannot import modules).

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, // master switch
  // --- saving ---
  saveMessages: true,
  captureNetwork: true, // read Messenger's own network data (normal chats)
  captureDom: true, // read messages shown on screen (works for encrypted chats too)
  captureNotifications: true, // keep a copy of Messenger desktop notifications
  saveMedia: true, // download photos/stickers so they survive an unsend
  maxMediaMB: 15, // per file
  retentionDays: 0, // 0 = keep forever
  // --- showing ---
  showRecoveredInline: true, // show the original text under "X unsent a message"
  showEditHistoryInline: true, // show the earlier text of edited messages
  notifyOnUnsend: true,
  notifyOnEdit: false,
  badge: true,
  // --- unseen ---
  blockSeen: true, // don't tell others you've read their messages
  stealthFocus: true, // strong mode (Messenger pages only): the page reports "no focus" so encrypted chats don't send Seen
  stealthVisibility: false, // also report the tab as hidden (can break encrypted chats with several tabs)
  blockTyping: true, // don't show "typing..." to others
  // --- downloads ---
  downloadButtons: true, // a Download button on photos, videos and reels, plus a right-click menu item
  downloadQuality: 'hd', // 'hd' = best quality, 'sd' = smaller file
  downloadAsk: false, // ask where to save each file (otherwise Downloads/Facebook)
});

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
