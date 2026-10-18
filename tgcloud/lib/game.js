// Game engine. The platform has no timers, so phase deadlines are enforced lazily:
// every update touching a game calls tick(), which advances a phase whose time is up.
// Every phase change goes through transition() — a compare-and-set on (status, round) —
// so when two updates race, exactly one of them performs the side effects.

import { db } from 'sdk';
import { eq, and, ne, or, isNull, lt, inArray, asc } from 'sdk/db';
import { games, players } from '../schema.js';
import { CATEGORIES } from './words.js';
import {
  now, esc, mention, normalizeWord, randomInt, shuffle, chunk,
  send, trySend, tryEdit, tryReact,
} from './util.js';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 14;
const WORDS_SEC = 60;
const DISCUSS_SEC = 60;
const VOTE_SEC = 60;
const GUESS_SEC = 30;
const STALE_LOBBY_SEC = 60 * 60;

export const IN_PLAY = ['words', 'discussion', 'voting', 'guess'];

export function spyCount(n) {
  return n <= 6 ? 1 : n <= 10 ? 2 : 3;
}

export const RULES = `🕵️ <b>Правила игры «Шпион»</b>

• Всем игрокам, кроме шпионов, бот присылает в личку загаданное слово. Шпионы знают только категорию.
• 3–6 игроков — 1 шпион, 7–10 — 2, 11–14 — 3. Шпионы не знают друг друга.
• <b>Раунд</b>: каждый пишет в чат <b>одно слово</b>, связанное с загаданным (${WORDS_SEC} сек). Само загаданное слово писать нельзя. Лишние сообщения удаляются.
• <b>Обсуждение</b> — ${DISCUSS_SEC} сек, затем <b>голосование</b> — ${VOTE_SEC} сек.
• Выбывает игрок с наибольшим числом голосов. При ничьей никто не выбывает.
• Если выбыл шпион — у него ${GUESS_SEC} сек, чтобы угадать слово в личке у бота. Угадал — шпионы победили, нет — игра идёт дальше.
• Мирные побеждают, когда пойманы все шпионы. Шпионы — когда их не меньше, чем мирных.

Команды: /spy — новая игра, /stop — остановить игру, /role — напомнить роль (в личке).
Боту нужны права админа с удалением сообщений.`;

// ── data access ────────────────────────────────────────────────────────────

export function getGame(id) {
  return db.select().from(games).where(eq(games.id, id)).get();
}

export function getActiveGame(chatId) {
  return db.select().from(games).where(and(eq(games.chatId, chatId), ne(games.status, 'finished'))).get();
}

export function getPlayers(gameId) {
  return db.select().from(players).where(eq(players.gameId, gameId)).orderBy(asc(players.id)).all();
}

async function transition(game, patch) {
  const rows = await db.update(games).set(patch)
    .where(and(eq(games.id, game.id), eq(games.status, game.status), eq(games.round, game.round)))
    .returning({ id: games.id });
  if (!rows.length) return false;
  Object.assign(game, patch);
  return true;
}

const categoryTitle = (game) => CATEGORIES[game.category]?.title ?? game.category;

// ── setup & lobby ──────────────────────────────────────────────────────────

export async function createGame(chat, host, warning) {
  const old = await getActiveGame(chat.id);
  if (old) {
    const stale = !IN_PLAY.includes(old.status) && now() - old.createdAt > STALE_LOBBY_SEC;
    if (!stale) return null;
    await transition(old, { status: 'finished', phaseEndsAt: null });
    if (old.panelMessageId) await tryEdit(old.chatId, old.panelMessageId, '⌛ Набор в игру истёк.');
  }
  const [game] = await db.insert(games).values({
    chatId: chat.id, chatTitle: chat.title ?? null, hostId: host.id, status: 'setup', categories: [],
  }).returning();
  const msg = await send(chat.id, setupText(game, warning), { reply_markup: { inline_keyboard: setupKeyboard(game) } });
  await db.update(games).set({ panelMessageId: msg.message_id }).where(eq(games.id, game.id));
  game.panelMessageId = msg.message_id;
  return game;
}

function setupText(game, warning) {
  return '🕵️ <b>Игра «Шпион»</b>\n\nВедущий (кто написал /spy) выбирает категории слов и жмёт «Дальше».'
    + (warning ? `\n\n⚠️ ${warning}` : '');
}

function setupKeyboard(game) {
  const selected = new Set(game.categories);
  const cats = Object.entries(CATEGORIES).map(([key, c]) => ({
    text: `${selected.has(key) ? '✅ ' : ''}${c.title}`, callback_data: `cat:${game.id}:${key}`,
  }));
  return [
    ...chunk(cats, 2),
    [{ text: 'Выбрать все', callback_data: `catall:${game.id}` }],
    [{ text: 'Дальше ➡️', callback_data: `catok:${game.id}` }, { text: '✖️ Отмена', callback_data: `cancel:${game.id}` }],
  ];
}

export async function toggleCategory(game, key) {
  const selected = new Set(game.categories);
  if (key === '*') {
    const all = Object.keys(CATEGORIES);
    const allOn = all.every((k) => selected.has(k));
    all.forEach((k) => (allOn ? selected.delete(k) : selected.add(k)));
  } else if (CATEGORIES[key]) {
    selected.has(key) ? selected.delete(key) : selected.add(key);
  }
  game.categories = [...selected];
  await db.update(games).set({ categories: game.categories }).where(and(eq(games.id, game.id), eq(games.status, 'setup')));
  await tryEdit(game.chatId, game.panelMessageId, setupText(game), setupKeyboard(game));
}

export async function openLobby(game) {
  if (!await transition(game, { status: 'lobby' })) return;
  await refreshLobby(game);
}

export async function refreshLobby(game) {
  const list = await getPlayers(game.id);
  const cats = game.categories.map((k) => CATEGORIES[k]?.title).filter(Boolean).join(', ');
  const lines = list.map((p, i) => `${i + 1}. ${esc(p.name)}`).join('\n') || '<i>пока никого</i>';
  const spies = list.length >= MIN_PLAYERS ? `Шпионов будет: <b>${spyCount(list.length)}</b>.` : `Нужно минимум ${MIN_PLAYERS} игрока.`;
  const text = `🕵️ <b>Игра «Шпион» — набор игроков</b>\n\nКатегории: ${cats}\n\n`
    + `<b>Игроки (${list.length}/${MAX_PLAYERS}):</b>\n${lines}\n\n${spies}\n\n`
    + 'Роль придёт в личку от бота — если бот попросит, откройте с ним чат и нажмите «Старт».';
  await tryEdit(game.chatId, game.panelMessageId, text, [
    [{ text: '🙋 Участвую', callback_data: `join:${game.id}` }, { text: '🚪 Выйти', callback_data: `leave:${game.id}` }],
    [{ text: '▶️ Начать игру', callback_data: `start:${game.id}` }],
    [{ text: '✖️ Отмена', callback_data: `cancel:${game.id}` }],
  ]);
}

// Returns a short status string for the caller to show the user.
export async function joinGame(game, user, name) {
  if (game.status !== 'lobby') return 'Набор в эту игру закрыт';
  const count = await db.$count(players, eq(players.gameId, game.id));
  if (count >= MAX_PLAYERS) return `Мест нет — максимум ${MAX_PLAYERS} игроков`;
  const rows = await db.insert(players).values({ gameId: game.id, userId: user.id, name })
    .onConflictDoNothing().returning({ id: players.id });
  if (!rows.length) return 'Ты уже в игре';
  await refreshLobby(game);
  return 'Ты в игре!';
}

export async function leaveGame(game, userId) {
  if (game.status !== 'lobby') return 'Игра уже началась';
  const rows = await db.delete(players).where(and(eq(players.gameId, game.id), eq(players.userId, userId)))
    .returning({ id: players.id });
  if (!rows.length) return 'Тебя нет в списке';
  await refreshLobby(game);
  return 'Ты вышел из игры';
}

export async function cancelGame(game, headline) {
  const wasInPlay = IN_PLAY.includes(game.status);
  if (!await transition(game, { status: 'finished', phaseEndsAt: null })) return;
  if (wasInPlay) {
    if (game.voteMessageId) await closeVoteMessage(game);
    await announceEnd(game, headline);
  } else {
    await tryEdit(game.chatId, game.panelMessageId, headline);
  }
}

// ── start & roles ──────────────────────────────────────────────────────────

export async function startGame(game) {
  const list = await getPlayers(game.id);
  if (list.length < MIN_PLAYERS) return `Нужно минимум ${MIN_PLAYERS} игрока`;
  const category = game.categories[randomInt(game.categories.length)];
  const pool = CATEGORIES[category].words;
  const word = pool[randomInt(pool.length)];
  if (!await transition(game, { status: 'words', round: 1, category, word, phaseEndsAt: now() + WORDS_SEC })) return null;

  const spyIds = shuffle(list).slice(0, spyCount(list.length)).map((p) => p.id);
  await db.update(players).set({ isSpy: true }).where(inArray(players.id, spyIds));

  await tryEdit(game.chatId, game.panelMessageId,
    `🕵️ <b>Игра «Шпион» началась!</b>\n\nИгроков: ${list.length}, шпионов: ${spyIds.length}.\nРоли отправлены в личку.`);
  const failed = [];
  for (const p of list) {
    p.isSpy = spyIds.includes(p.id);
    if (!await trySend(p.userId, roleText(game, p))) failed.push(p);
  }
  if (failed.length) {
    await send(game.chatId, `⚠️ Не смог написать в личку: ${failed.map((p) => mention(p.userId, p.name)).join(', ')}. `
      + 'Откройте чат с ботом и отправьте /role.');
  }
  await announceRound(game);
  return 'Игра началась!';
}

export function roleText(game, p) {
  const where = game.chatTitle ? ` в «${esc(game.chatTitle)}»` : '';
  return p.isSpy
    ? `🕵️ Игра${where}: ты — <b>ШПИОН</b>!\n\nКатегория: ${categoryTitle(game)}\nСлово тебе неизвестно. Притворяйся своим и попробуй его угадать.`
    : `🎲 Игра${where}: ты — мирный житель.\n\nКатегория: ${categoryTitle(game)}\nСлово: <b>${esc(game.word)}</b>\n\nНайди шпиона, но не выдавай слово слишком явно.`;
}

// ── rounds ─────────────────────────────────────────────────────────────────

const nextRoundPatch = (game) => ({
  status: 'words', round: game.round + 1, phaseEndsAt: now() + WORDS_SEC, guessUserId: null, voteMessageId: null,
});

async function announceRound(game, prefix) {
  const alive = (await getPlayers(game.id)).filter((p) => p.alive);
  await send(game.chatId, (prefix ? `${prefix}\n\n` : '')
    + `📝 <b>Раунд ${game.round}</b>\nКаждый игрок пишет в чат <b>одно слово</b>, связанное с загаданным. `
    + `Время — ${WORDS_SEC} сек.\n\nИграют: ${alive.map((p) => mention(p.userId, p.name)).join(', ')}`);
}

// A message in the group from someone while the game is in play.
// Returns true when the message is allowed to stay.
export async function onGroupMessage(game, message) {
  const all = await getPlayers(game.id);
  const player = all.find((p) => p.alive && p.userId === message.from?.id);
  if (!player) return false;
  if (game.status !== 'words') return true;

  const raw = message.text?.trim();
  const isOneWord = raw && !raw.startsWith('/') && !/\s/.test(raw) && /\p{L}/u.test(raw) && raw.length <= 40;
  if (!isOneWord) return false;
  // A civilian naming the secret word is removed. A spy saying it by luck stays —
  // deleting it would tell the spy they hit the word.
  if (!player.isSpy && normalizeWord(raw) === normalizeWord(game.word)) return false;

  const rows = await db.update(players).set({ word: raw, wordRound: game.round })
    .where(and(eq(players.id, player.id), or(isNull(players.wordRound), lt(players.wordRound, game.round))))
    .returning({ id: players.id });
  if (!rows.length) return false;   // already wrote this round
  await tryReact(game.chatId, message.message_id, '👍');

  player.wordRound = game.round;
  if (all.filter((p) => p.alive).every((p) => p.wordRound === game.round)) await toDiscussion(game);
  return true;
}

async function toDiscussion(game) {
  if (!await transition(game, { status: 'discussion', phaseEndsAt: now() + DISCUSS_SEC })) return;
  const alive = (await getPlayers(game.id)).filter((p) => p.alive);
  const lines = alive.map((p) =>
    `• ${esc(p.name)} — ${p.wordRound === game.round ? `<b>${esc(p.word)}</b>` : '<i>нет слова</i>'}`).join('\n');
  await send(game.chatId, `🗒 <b>Слова раунда ${game.round}:</b>\n${lines}\n\n`
    + `💬 <b>Обсуждение</b> — ${DISCUSS_SEC} сек. Потом голосование.`);
}

// ── voting ─────────────────────────────────────────────────────────────────

async function toVoting(game) {
  if (!await transition(game, { status: 'voting', phaseEndsAt: now() + VOTE_SEC })) return;
  const alive = (await getPlayers(game.id)).filter((p) => p.alive);
  const msg = await send(game.chatId, voteText(game, alive, false), { reply_markup: { inline_keyboard: voteKeyboard(game, alive) } });
  await db.update(games).set({ voteMessageId: msg.message_id }).where(eq(games.id, game.id));
  game.voteMessageId = msg.message_id;
}

const votedThisRound = (game, p) => p.voteRound === game.round && p.vote != null;

function tally(game, alive) {
  const counts = new Map();
  for (const p of alive) if (votedThisRound(game, p)) counts.set(p.vote, (counts.get(p.vote) ?? 0) + 1);
  return counts;
}

function voteText(game, alive, closed) {
  const byId = new Map(alive.map((p) => [p.userId, p]));
  const voted = alive.filter((p) => votedThisRound(game, p));
  const lines = voted.map((p) => `• ${esc(p.name)} → ${esc(byId.get(p.vote)?.name ?? '?')}`).join('\n');
  return `🗳 <b>Голосование${closed ? ' завершено' : ` — ${VOTE_SEC} сек`}</b>\nКто шпион?\n\n`
    + `Проголосовали: ${voted.length}/${alive.length}${lines ? `\n${lines}` : ''}`;
}

function voteKeyboard(game, alive) {
  const counts = tally(game, alive);
  return chunk(alive.map((p) => {
    const n = counts.get(p.userId);
    return { text: `${p.name}${n ? ` · ${n}` : ''}`, callback_data: `vote:${game.id}:${p.userId}` };
  }), 2);
}

async function closeVoteMessage(game) {
  const alive = (await getPlayers(game.id)).filter((p) => p.alive);
  await tryEdit(game.chatId, game.voteMessageId, voteText(game, alive, true));
}

export async function castVote(game, voterId, targetId) {
  if (game.status !== 'voting') return 'Голосование сейчас не идёт';
  const alive = (await getPlayers(game.id)).filter((p) => p.alive);
  const voter = alive.find((p) => p.userId === voterId);
  const target = alive.find((p) => p.userId === targetId);
  if (!voter) return 'Голосуют только игроки, которые ещё в игре';
  if (!target) return 'Этот игрок уже выбыл';
  if (voter.userId === target.userId) return 'Нельзя голосовать за себя';

  await db.update(players).set({ vote: target.userId, voteRound: game.round }).where(eq(players.id, voter.id));
  Object.assign(voter, { vote: target.userId, voteRound: game.round });
  if (alive.every((p) => votedThisRound(game, p))) {
    await resolveVotes(game);
  } else {
    await tryEdit(game.chatId, game.voteMessageId, voteText(game, alive, false), voteKeyboard(game, alive));
  }
  return `Твой голос: ${target.name}`;
}

async function resolveVotes(game) {
  const all = await getPlayers(game.id);
  const alive = all.filter((p) => p.alive);
  const counts = tally(game, alive);
  const max = Math.max(0, ...counts.values());
  const leaders = [...counts].filter(([, n]) => n === max).map(([id]) => id);
  // Captured up front: a transition to the next round bumps `round` and clears `voteMessageId`.
  const voteMessageId = game.voteMessageId;
  const closedText = voteText(game, alive, true);

  if (!counts.size || leaders.length > 1) {
    if (!await transition(game, nextRoundPatch(game))) return;
    await tryEdit(game.chatId, voteMessageId, closedText);
    await announceRound(game, counts.size ? '⚖️ Голоса разделились — никто не выбывает.' : '🤷 Никто не проголосовал — никто не выбывает.');
    return;
  }

  const out = alive.find((p) => p.userId === leaders[0]);
  const label = mention(out.userId, out.name);
  if (out.isSpy) {
    if (!await transition(game, { status: 'guess', guessUserId: out.userId, phaseEndsAt: now() + GUESS_SEC })) return;
    await tryEdit(game.chatId, voteMessageId, closedText);
    await send(game.chatId, `🕵️ ${label} — <b>шпион</b>!\n\nУ шпиона ${GUESS_SEC} сек, чтобы угадать загаданное слово `
      + '(пишет боту в личку). Угадает — шпионы победят.');
    const dm = await trySend(out.userId, `😱 Тебя раскрыли! Напиши мне загаданное слово — у тебя ${GUESS_SEC} сек.\n`
      + `Категория: ${categoryTitle(game)}`);
    if (!dm) await send(game.chatId, `⚠️ Не смог написать ${label} в личку — откройте чат с ботом и напишите слово.`);
    return;
  }
  if (await afterElimination(game, all, out, `🚪 ${label} покидает игру. Это был <b>не шпион</b>.`)) {
    await tryEdit(game.chatId, voteMessageId, closedText);
  }
}

// ── spy's guess ────────────────────────────────────────────────────────────

// text = null means the spy ran out of time.
export async function resolveGuess(game, text) {
  const all = await getPlayers(game.id);
  const spy = all.find((p) => p.userId === game.guessUserId);
  const label = mention(spy.userId, spy.name);
  if (text != null && normalizeWord(text) === normalizeWord(game.word)) {
    if (!await transition(game, { status: 'finished', phaseEndsAt: null })) return null;
    await announceEnd(game, `🎯 Шпион ${label} угадал слово!\n\n🕵️ <b>Победа шпионов!</b>`);
    return true;
  }
  const headline = text == null
    ? `⌛ Время вышло — шпион ${label} не назвал слово и выбывает.`
    : `❌ Шпион ${label} назвал «${esc(text)}» — мимо! Шпион выбывает.`;
  return (await afterElimination(game, all, spy, headline)) ? false : null;
}

// Removes `out` from the game, then either ends it or starts the next round.
async function afterElimination(game, all, out, headline) {
  const alive = all.filter((p) => p.alive && p.userId !== out.userId);
  const spies = alive.filter((p) => p.isSpy).length;
  const civilians = alive.length - spies;
  const result = spies === 0 ? '🎉 Все шпионы пойманы — <b>победа мирных жителей!</b>'
    : spies >= civilians ? '🕵️ Шпионов не меньше, чем мирных — <b>победа шпионов!</b>'
    : null;

  const ok = await transition(game, result ? { status: 'finished', phaseEndsAt: null } : nextRoundPatch(game));
  if (!ok) return false;
  await db.update(players).set({ alive: false }).where(eq(players.id, out.id));
  if (result) await announceEnd(game, `${headline}\n\n${result}`);
  else await announceRound(game, headline);
  return true;
}

async function announceEnd(game, headline) {
  const all = await getPlayers(game.id);
  const spies = all.filter((p) => p.isSpy).map((p) => mention(p.userId, p.name)).join(', ');
  await send(game.chatId, `${headline}\n\nЗагаданное слово: <b>${esc(game.word)}</b> (${categoryTitle(game)})\n`
    + `Шпион${all.filter((p) => p.isSpy).length > 1 ? 'ы' : ''}: ${spies}\n\nНовая игра — /spy`);
}

// ── deadlines ──────────────────────────────────────────────────────────────

export async function tick(game) {
  if (!game?.phaseEndsAt || now() < game.phaseEndsAt) return;
  switch (game.status) {
    case 'words': return toDiscussion(game);
    case 'discussion': return toVoting(game);
    case 'voting': return resolveVotes(game);
    case 'guess': return resolveGuess(game, null);
  }
}

export function findGuessingGame(userId) {
  return db.select().from(games).where(and(eq(games.status, 'guess'), eq(games.guessUserId, userId))).get();
}

export async function findPlayingGames(userId) {
  const mine = await db.select({ gameId: players.gameId }).from(players).where(eq(players.userId, userId)).all();
  if (!mine.length) return [];
  return db.select().from(games)
    .where(and(inArray(games.id, mine.map((r) => r.gameId)), inArray(games.status, IN_PLAY))).all();
}
