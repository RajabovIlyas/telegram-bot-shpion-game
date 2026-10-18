// handlers/message.js — group commands, enforcing the word round, and the private
// chat (joining via deep link, /role, the caught spy's guess).

import { api } from 'sdk';
import {
  RULES, IN_PLAY, getGame, getActiveGame, createGame, cancelGame, joinGame, onGroupMessage,
  roleText, tick, resolveGuess, findGuessingGame, findPlayingGames, getPlayers,
} from '../lib/game.js';
import { send, tryDelete, displayName, getMe, isChatAdmin, esc } from '../lib/util.js';
import { isAdmin, sendUserList } from '../lib/admin.js';
import { recordUser } from '../lib/users.js';

// Telegram service messages (joins, pins, title changes…) aren't something a player wrote.
const SERVICE_KEYS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo', 'delete_chat_photo',
  'group_chat_created', 'supergroup_chat_created', 'migrate_to_chat_id', 'migrate_from_chat_id',
  'pinned_message', 'message_auto_delete_timer_changed', 'video_chat_started', 'video_chat_ended',
  'video_chat_scheduled', 'video_chat_participants_invited', 'forum_topic_created', 'forum_topic_edited',
  'forum_topic_closed', 'forum_topic_reopened', 'boost_added', 'chat_background_set',
];

// "/spy@MyBot arg" → { name: 'spy', arg: 'arg' }; null if not a command or addressed to another bot.
async function parseCommand(text) {
  const m = /^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text ?? '');
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== (await getMe()).username.toLowerCase()) return null;
  return { name: m[1].toLowerCase(), arg: (m[3] ?? '').trim() };
}

export default async function (message) {
  await recordUser(message.from);
  if (message.chat.type === 'private') return onPrivate(message);
  if (message.chat.type === 'group' || message.chat.type === 'supergroup') return onGroup(message);
}

async function onGroup(message) {
  if (SERVICE_KEYS.some((k) => k in message)) return;
  const chatId = message.chat.id;
  const cmd = await parseCommand(message.text);

  const game = await getActiveGame(chatId);
  if (game) await tick(game);
  const active = game && game.status !== 'finished' ? game : null;

  if (cmd?.name === 'stop' && active) {
    if (message.from.id !== active.hostId && !await isChatAdmin(chatId, message.from.id)) {
      return send(chatId, 'Остановить игру может только ведущий или админ чата.', { reply_parameters: { message_id: message.message_id } });
    }
    return cancelGame(active, '⛔ Игра остановлена.');
  }

  if (active && IN_PLAY.includes(active.status)) {
    if (!await onGroupMessage(active, message)) await tryDelete(chatId, message.message_id);
    return;
  }

  if (cmd?.name === 'spy') {
    if (active) return send(chatId, 'В этом чате уже идёт набор в игру — смотрите сообщение выше.');
    return createGame(message.chat, message.from, await rightsWarning(chatId));
  }
  if (cmd?.name === 'rules' || cmd?.name === 'help') return send(chatId, RULES);
}

async function rightsWarning(chatId) {
  const me = await getMe();
  const m = await api.getChatMember({ chat_id: chatId, user_id: me.id }).catch(() => null);
  if (m?.status === 'administrator' && m.can_delete_messages) return null;
  return 'Сделайте бота админом с правом удалять сообщения — иначе он не увидит слова игроков и не сможет удалять лишние сообщения.';
}

async function onPrivate(message) {
  const user = message.from;
  const cmd = await parseCommand(message.text);

  if (cmd?.name === 'start') {
    const id = /^g(\d+)$/.exec(cmd.arg)?.[1];
    const game = id && await getGame(Number(id));
    if (game) {
      const status = await joinGame(game, user, displayName(user));
      const joined = status === 'Ты в игре!' || status === 'Ты уже в игре';
      return send(user.id, joined
        ? `✅ ${status}${game.chatTitle ? ` («${esc(game.chatTitle)}»)` : ''} Роль придёт сюда, когда игра начнётся.`
        : status);
    }
    return send(user.id, `Привет! Добавь меня в группу, сделай админом и напиши там /spy.\n\n${RULES}`);
  }

  if (cmd?.name === 'role') {
    const list = await findPlayingGames(user.id);
    if (!list.length) return send(user.id, 'Ты сейчас не участвуешь ни в одной игре.');
    for (const game of list) {
      const me = (await getPlayers(game.id)).find((p) => p.userId === user.id);
      await send(user.id, roleText(game, me) + (me.alive ? '' : '\n\n<i>Ты уже выбыл(а) из игры.</i>'));
    }
    return;
  }

  if (cmd?.name === 'rules' || cmd?.name === 'help') return send(user.id, RULES);

  if (cmd?.name === 'users' && isAdmin(user.id)) return sendUserList(user.id);

  const game = await findGuessingGame(user.id);
  if (game && message.text && !cmd) {
    await tick(game);   // too late? then the timeout has just been resolved
    if (game.status !== 'guess') return send(user.id, '⌛ Время на ответ вышло.');
    const correct = await resolveGuess(game, message.text.trim());
    if (correct === true) return send(user.id, '🎯 Верно! Шпионы победили.');
    if (correct === false) return send(user.id, '❌ Неверно. Ты выбываешь из игры.');
    return;
  }

  return send(user.id, 'Чтобы начать игру, добавь меня в группу и напиши там /spy. Правила — /rules.');
}
