// lib/commands.js — the "/" command menu Telegram shows in groups and in the private chat.

import { api } from 'sdk';

const GROUP_COMMANDS = [
  { command: 'spy', description: 'Начать новую игру' },
  { command: 'stop', description: 'Остановить игру' },
  { command: 'rules', description: 'Правила игры' },
];

const PRIVATE_COMMANDS = [
  { command: 'start', description: 'Как начать игру' },
  { command: 'role', description: 'Напомнить мою роль' },
  { command: 'rules', description: 'Правила игры' },
];

// setMyCommands is idempotent; run it once per isolate so the menu stays in sync with
// this file after a deploy without a separate setup step.
let done = false;
export async function ensureCommands() {
  if (done) return;
  done = true;
  try {
    await api.setMyCommands({ commands: GROUP_COMMANDS, scope: { type: 'all_group_chats' } });
    await api.setMyCommands({ commands: PRIVATE_COMMANDS, scope: { type: 'all_private_chats' } });
  } catch (e) {
    done = false;
    console.error(e);
  }
}
