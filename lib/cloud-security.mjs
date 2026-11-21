import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';


export const fail = (status, message) => Object.assign(new Error(message), { status });
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function text(value, max, label, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(400, `请填写有效的${label}（最多 ${max} 字）。`);
  return value.trim();
}
export function vaultAt(directory) {
  const filename = path.join(directory, 'master.key');
  if (!existsSync(filename)) writeFileSync(filename, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  const key = Buffer.from(readFileSync(filename, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw Error('Invalid cloud master key');
  return (value, operation, owner = '') => {
    if (operation === 'seal') {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(owner));
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
    }
    const [iv, tag, body] = value.split('.').map(v => Buffer.from(v, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(owner)); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8');
  };
}
export async function readBody(req, limit = 15 * 1024 * 1024) {
  if (Number(req.headers['content-length']) > limit) throw fail(413, '内容过大。');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail(413, '内容过大。'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function json(body) {
  try { const value = JSON.parse(body); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; }
  catch { throw fail(400, '请求格式不正确。'); }
}
export const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
