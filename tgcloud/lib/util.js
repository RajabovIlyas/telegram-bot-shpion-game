import { api, BotApiError } from 'sdk';

export const now = () => Math.floor(Date.now() / 1000);

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id);
}

export function mention(userId, name) {
  return `<a href="tg://user?id=${userId}">${esc(name)}</a>`;
}

// Lowercase, ё → е, letters and digits only — "Хот-дог!" and "хотдог" compare equal.
export function normalizeWord(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
}

export function randomInt(n) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

let me = null;
export async function getMe() {
  me ??= await api.getMe();
  return me;
}

export function send(chatId, text, extra = {}) {
  return api.sendMessage({
    chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra,
  });
}

// Bot API calls whose failure is expected and harmless (user never opened the DM,
// bot isn't an admin, message already gone / not modified) return null instead of throwing.
async function soft(promise) {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof BotApiError) return null;
    throw e;
  }
}

export const trySend = (chatId, text, extra) => soft(send(chatId, text, extra));

export const tryDelete = (chatId, messageId) =>
  soft(api.deleteMessage({ chat_id: chatId, message_id: messageId }));

export const tryEdit = (chatId, messageId, text, keyboard = []) =>
  soft(api.editMessageText({
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard },
  }));

// Silent check that the bot may write to this user (they pressed Start and didn't block it).
export const canMessage = async (userId) =>
  (await soft(api.sendChatAction({ chat_id: userId, action: 'typing' }))) !== null;

export const tryReact = (chatId, messageId, emoji) =>
  soft(api.setMessageReaction({ chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] }));

export async function isChatAdmin(chatId, userId) {
  const m = await soft(api.getChatMember({ chat_id: chatId, user_id: userId }));
  return m?.status === 'creator' || m?.status === 'administrator';
}
