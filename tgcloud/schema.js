import { table, integer, text, boolean, json, index, uniqueIndex, sql } from 'sdk/db';

// One row per game. A chat has at most one game whose status isn't 'finished'.
// status: setup → lobby → words → discussion → voting → (guess) → words … → finished
export const games = table('games', {
  id:             integer('id').primaryKey({ autoIncrement: true }),
  chatId:         integer('chat_id').notNull(),
  chatTitle:      text('chat_title'),
  hostId:         integer('host_id').notNull(),
  status:         text('status').notNull(),
  categories:     json('categories').default([]),
  category:       text('category'),
  word:           text('word'),
  round:          integer('round').notNull().default(0),
  phaseEndsAt:    integer('phase_ends_at'),          // unix seconds; null = no deadline
  panelMessageId: integer('panel_message_id'),       // setup/lobby message
  voteMessageId:  integer('vote_message_id'),
  guessUserId:    integer('guess_user_id'),          // the caught spy who is guessing
  createdAt:      integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  chatStatusIdx: index('idx_games_chat_status').on(t.chatId, t.status),
}));

export const players = table('players', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  gameId:    integer('game_id').notNull(),           // logical link to games.id
  userId:    integer('user_id').notNull(),
  name:      text('name').notNull(),
  isSpy:     boolean('is_spy').default(false),
  alive:     boolean('alive').default(true),
  word:      text('word'),                           // the word written in round `wordRound`
  wordRound: integer('word_round'),
  vote:      integer('vote'),                        // target userId, cast in round `voteRound`
  voteRound: integer('vote_round'),
}, (t) => ({
  gameUserIdx: uniqueIndex('uidx_players_game_user').on(t.gameId, t.userId),
  userIdx:     index('idx_players_user').on(t.userId),
}));

// Everyone who has ever sent the bot anything (message or button press), keyed by Telegram user id.
export const users = table('users', {
  id:           integer('id').primaryKey(),          // Telegram user id
  username:     text('username'),
  firstName:    text('first_name'),
  lastName:     text('last_name'),
  languageCode: text('language_code'),
  isPremium:    boolean('is_premium').default(false),
  requests:     integer('requests').notNull().default(0),
  firstSeen:    integer('first_seen').default(sql`(unixepoch())`),
  lastSeen:     integer('last_seen').default(sql`(unixepoch())`),
}, (t) => ({
  lastSeenIdx: index('idx_users_last_seen').on(t.lastSeen),
}));
