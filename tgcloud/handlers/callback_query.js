// handlers/callback_query.js — inline buttons: category setup, lobby, voting.
// callback_data is "<action>:<gameId>[:<arg>]".

import { api } from 'sdk';
import {
  getGame, tick, toggleCategory, openLobby, joinGame, leaveGame, startGame, cancelGame, castVote,
} from '../lib/game.js';
import { displayName, getMe, isChatAdmin, canMessage } from '../lib/util.js';
import { recordUser } from '../lib/users.js';

export default async function (cq) {
  await recordUser(cq.from);
  const answer = (text, extra = {}) => api.answerCallbackQuery({ callback_query_id: cq.id, text, ...extra });
  const [action, gameId, arg] = (cq.data ?? '').split(':');
  const game = gameId && await getGame(Number(gameId));
  if (!game || game.status === 'finished') return answer('Эта игра уже завершена');
  await tick(game);
  if (game.status === 'finished') return answer('Эта игра уже завершена');

  const isHost = cq.from.id === game.hostId;
  const hostOnly = 'Это может сделать только ведущий';

  switch (action) {
    case 'cat':
    case 'catall':
      if (game.status !== 'setup') return answer();
      if (!isHost) return answer(hostOnly);
      await toggleCategory(game, action === 'catall' ? '*' : arg);
      return answer();

    case 'catok':
      if (game.status !== 'setup') return answer();
      if (!isHost) return answer(hostOnly);
      if (!game.categories.length) return answer('Выберите хотя бы одну категорию', { show_alert: true });
      await openLobby(game);
      return answer('Набор игроков открыт');

    case 'join': {
      if (game.status !== 'lobby') return answer('Набор в эту игру закрыт');
      // The role arrives by DM. If the user never opened the bot, send them there —
      // the deep link's /start g<id> joins them from the private chat.
      if (!await canMessage(cq.from.id)) {
        const me = await getMe();
        return answer(undefined, { url: `https://t.me/${me.username}?start=g${game.id}` });
      }
      return answer(await joinGame(game, cq.from, displayName(cq.from)));
    }

    case 'leave':
      return answer(await leaveGame(game, cq.from.id));

    case 'start': {
      if (game.status !== 'lobby') return answer();
      if (!isHost) return answer(hostOnly);
      const result = await startGame(game);
      return answer(result ?? undefined, { show_alert: result?.startsWith('Нужно') ?? false });
    }

    case 'cancel':
      if (!isHost && !await isChatAdmin(game.chatId, cq.from.id)) return answer('Отменить может ведущий или админ чата');
      await cancelGame(game, '✖️ Игра отменена.');
      return answer('Игра отменена');

    case 'vote':
      return answer(await castVote(game, cq.from.id, Number(arg)));

    default:
      return answer();
  }
}
