let accessToken = '';
let refreshing: Promise<void> | null = null;
const base = import.meta.env.VITE_API_URL || '/api';
export function setToken(value: string) { accessToken = value; }
async function refresh() {
  const response = await fetch(`${base}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new Error('Please sign in.');
  const data = await response.json(); accessToken = data.accessToken;
}
export async function api<T = Record<string, unknown>>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...options, credentials: 'include', headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...options.headers } });
  if (response.status === 401 && retry && !path.startsWith('/auth/') && !path.startsWith('/events')) {
    refreshing ||= refresh().finally(() => { refreshing = null; });
    await refreshing; return api(path, options, false);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
