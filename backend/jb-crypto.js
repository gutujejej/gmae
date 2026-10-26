// Bot tokens are stored encrypted (AES-256-GCM). TOKEN_KEY is a long random secret in your server environment.
const crypto = require('crypto');
const key = () => {
  const k = process.env.TOKEN_KEY || '';
  if (k.length < 24) throw new Error('TOKEN_KEY must be set (at least 24 characters). Example: openssl rand -hex 32');
  return crypto.createHash('sha256').update(k).digest();
};
const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
};
const decrypt = (blob) => {
  const [iv, tag, enc] = String(blob).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
};
const randomSecret = (n = 24) => crypto.randomBytes(n).toString('base64url');
module.exports = { encrypt, decrypt, randomSecret };
