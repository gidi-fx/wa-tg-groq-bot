import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

import { AppError } from './errors.js';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '',
).trim();

export const MEDIA_BUCKET = String(process.env.SUPABASE_MEDIA_BUCKET || 'agent-media').trim();

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

/** true when SUPABASE_URL + SUPABASE_KEY are set - persistence is optional. */
export const hasSupabase = isSupabaseConfigured();

export const supabase = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

export function requireSupabase() {
  if (!supabase) {
    throw new AppError(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_KEY, then run supabase/schema.sql.',
      503,
      'supabase_not_configured',
    );
  }
  return supabase;
}

/** Turn a Supabase client error into an actionable AppError. */
export function dbError(error, context = 'Supabase request failed') {
  const message = error?.message || String(error || 'unknown error');
  const missingTable = /relation .* does not exist|Could not find the table|schema cache/i.test(message);
  const hint = missingTable ? ' Run supabase/schema.sql in the Supabase SQL editor.' : '';
  return new AppError(`${context}: ${message}.${hint}`, 502, 'supabase_error');
}

export function safeFileName(name, fallback = 'file') {
  const base = String(name || fallback)
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(-80);
  return base || fallback;
}

export function mediaPublicUrl(path) {
  const db = requireSupabase();
  const { data } = db.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

export async function uploadMedia(buffer, objectPath, contentType = 'application/octet-stream') {
  const db = requireSupabase();
  const { error } = await db.storage
    .from(MEDIA_BUCKET)
    .upload(objectPath, buffer, { contentType, upsert: true, cacheControl: '3600' });
  if (error) {
    throw new AppError(`Media upload failed: ${error.message}`, 502, 'storage_upload_failed');
  }
  return mediaPublicUrl(objectPath);
}

export async function downloadMediaByPath(objectPath) {
  const db = requireSupabase();
  const { data, error } = await db.storage.from(MEDIA_BUCKET).download(objectPath);
  if (error || !data) {
    throw new AppError(`Media download failed: ${error?.message || 'not found'}`, 502, 'storage_download_failed');
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  return { buffer, contentType: data.type || 'application/octet-stream' };
}

export async function removeMediaByPath(objectPath) {
  if (!objectPath) return;
  const db = requireSupabase();
  const { error } = await db.storage.from(MEDIA_BUCKET).remove([objectPath]);
  if (error) console.warn(`[storage] could not remove ${objectPath}: ${error.message}`);
}

/** Deterministic-ish unique object path for uploads. */
export function mediaObjectPath(prefix, fileName) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = createHash('sha1').update(`${stamp}:${Math.random()}`).digest('hex').slice(0, 8);
  return `${prefix}/${stamp}-${random}-${safeFileName(fileName)}`;
}
