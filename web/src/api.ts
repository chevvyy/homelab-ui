import type { Problem } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public problem: Partial<Problem>,
  ) {
    super(problem.title ?? `HTTP ${status}`);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = { error: { title: text } };
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? { title: `HTTP ${res.status}` });
  return data as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);
export const post = <T = any>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const put = <T = any>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const del = <T = any>(path: string) => api<T>('DELETE', path);

export function appPath(id: string): string {
  const [ns, name] = id.split('/');
  return `/apps/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`;
}
