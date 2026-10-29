// lib/users.js — remembers every user who sends the bot an update.

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { users } from '../schema.js';

// Upsert the sender's profile and bump their request counter. Never throws:
// a failed write must not break handling of the update itself.
export async function recordUser(from) {
  if (!from || from.is_bot) return;
  const profile = {
    username:     from.username ?? null,
    firstName:    from.first_name ?? null,
    lastName:     from.last_name ?? null,
    languageCode: from.language_code ?? null,
    isPremium:    !!from.is_premium,
    lastSeen:     sql`(unixepoch())`,
  };
  try {
    await db.insert(users).values({ id: from.id, ...profile, requests: 1 })
      .onConflictDoUpdate({ target: users.id, set: { ...profile, requests: sql`${users.requests} + 1` } })
      .run();
  } catch (e) {
    console.error('recordUser failed', e);
  }
}
