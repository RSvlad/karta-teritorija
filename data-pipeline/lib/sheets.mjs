// Reads sheet ranges with a service-account key. Uses only node:crypto and fetch,
// so the build needs no extra dependencies.
import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const b64url = (input) => Buffer.from(input).toString('base64url');

export function parseCredentials(json) {
  let key;
  try {
    key = JSON.parse(json);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT није исправан JSON');
  }
  if (!key.client_email || !key.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT нема client_email и private_key');
  }
  return key;
}

export async function getAccessToken(key, now = Math.floor(Date.now() / 1000)) {
  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const unsigned = [
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })),
  ].join('.');
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Google пријава није успела (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

/**
 * Returns the sheet as a 2D array of strings, header row first.
 * With `optional`, a tab that does not exist gives null instead of an error.
 */
export async function fetchSheet(token, spreadsheetId, title, { optional = false } = {}) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(title)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 400 || res.status === 404) {
    if (optional) return null;
    throw new Error(`лист „${title}“ не постоји у Sheet-у ${spreadsheetId} (${res.status})`);
  }
  if (!res.ok) throw new Error(`читање листа „${title}“ није успело (${res.status}): ${await res.text()}`);
  return (await res.json()).values ?? [];
}
