// lib/admin.js — bot-owner commands (private chat only).

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { users as usersTable } from '../schema.js';
import { send, esc } from './util.js';

// Telegram user ids allowed to use admin commands.
export const ADMIN_IDS = [7593657575];

export const isAdmin = (userId) => ADMIN_IDS.includes(userId);

// The most recently active users: profile, request count, games played, last activity.
export async function listUsers(limit) {
  return db.all(sql`
    SELECT u.id AS userId, u.username AS username,
           trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) AS name,
           u.requests AS requests, u.last_seen AS lastSeen,
           (SELECT count(DISTINCT p.game_id) FROM players p WHERE p.user_id = u.id) AS games
    FROM users u
    ORDER BY u.last_seen DESC
    LIMIT ${limit}`);
}

// Pad/truncate to a fixed number of characters (code points, so Cyrillic and emoji count as one).
function cell(value, width, alignRight = false) {
  let chars = Array.from(String(value ?? ''));
  if (chars.length > width) chars = [...chars.slice(0, width - 1), '…'];
  const str = chars.join('');
  const pad = ' '.repeat(width - chars.length);
  return alignRight ? pad + str : str + pad;
}

const COLUMNS = [
  { title: '#',     width: 3,  right: true },
  { title: 'Имя',   width: 14 },
  { title: 'ID',    width: 10, right: true },
  { title: 'Запр',  width: 4,  right: true },
  { title: 'Игр',   width: 3,  right: true },
  { title: 'Был',   width: 5 },
];

const row = (values) => COLUMNS.map((c, i) => cell(values[i], c.width, c.right)).join(' ');

export async function sendUserList(chatId, limit = 5) {
  const users = await listUsers(limit);
  if (!users.length) return send(chatId, 'Пока никто не писал боту.');
  const total = await db.$count(usersTable);
  const header = row(COLUMNS.map((c) => c.title));
  const rule = '─'.repeat(header.length);
  const lines = users.map((u, i) => {
    const date = u.lastSeen
      ? new Date(u.lastSeen * 1000).toISOString().slice(5, 10).split('-').reverse().join('.')
      : '—';
    const name = u.username ? `@${u.username}` : (u.name || '—');
    return row([i + 1, name, u.userId, u.requests, u.games, date]);
  });
  const head = `👥 <b>Пользователи: ${total}</b> (последние ${users.length})\n`;
  return send(chatId, `${head}<pre>${esc([header, rule, ...lines].join('\n'))}</pre>`);
}
