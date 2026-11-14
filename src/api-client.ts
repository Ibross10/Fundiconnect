const configuredApiBase = (import.meta.env?.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export function resolveApiUrl(path: string, base = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const normalizedBase = base.trim().replace(/\/+$/, '');
  return normalizedBase ? `${normalizedBase}${normalizedPath}` : normalizedPath;
}

export function apiUrl(path: string) {
  return resolveApiUrl(path, configuredApiBase);
}

export function apiFetch(path: string, options?: RequestInit) {
  return fetch(apiUrl(path), options);
}
