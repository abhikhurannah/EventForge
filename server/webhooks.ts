import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { signature } from './core.js';

export function publicIPv4(address: string) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}
export async function resolveWebhook(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) throw new Error('Use a public HTTPS URL on port 443 without credentials or a fragment.');
  const addresses = await dns.resolve4(url.hostname);
  if (!addresses.length || addresses.some(ip => !publicIPv4(ip))) throw new Error('Webhook destination must resolve to public IPv4 addresses.');
  return { url, address: addresses[0] };
}
export async function sendWebhook(raw: string, secret: string, body: string, id: string) {
  const { url, address } = await resolveWebhook(raw);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return new Promise<number>((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST', family: 4,
      // Pin the checked address while preserving TLS hostname verification.
      lookup: (_host, _options, cb) => cb(null, address, 4),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-eventforge-id': id, 'x-eventforge-timestamp': timestamp, 'x-eventforge-signature': signature(secret, timestamp, body) },
    }, res => { res.destroy(); resolve(res.statusCode || 0); });
    const timer = setTimeout(() => req.destroy(new Error('DELIVERY_TIMEOUT')), 10000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}
