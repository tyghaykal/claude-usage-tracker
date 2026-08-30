import type { UsageFilter } from './types';

/** Thrown for any non-2xx response, carrying the server's message and status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
/** Called when a refresh finally fails, so the app can send the user to /login. */
let onSessionLost: () => void = () => {};

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const getAccessToken = () => accessToken;
export const setSessionLostHandler = (handler: () => void) => {
  onSessionLost = handler;
};

async function parse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Internal: stops a refresh failure from recursing forever. */
  retryOnUnauthorized?: boolean;
}

/**
 * One fetch wrapper for the whole app. A 401 on an authenticated call triggers
 * exactly one silent refresh attempt (the refresh cookie is httpOnly, so the
 * browser sends it for us) before the session is treated as lost.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, retryOnUnauthorized = true } = options;

  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401 && accessToken && retryOnUnauthorized) {
    const refreshed = await refresh();
    if (refreshed) return api<T>(path, { ...options, retryOnUnauthorized: false });
    setAccessToken(null);
    onSessionLost();
  }

  const payload = (await parse(response)) as { error?: string; details?: unknown } | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error ?? `Request failed (${response.status})`,
      payload?.details,
    );
  }
  return payload as T;
}

async function refresh(): Promise<boolean> {
  const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
  if (!response.ok) return false;
  const body = (await response.json()) as { accessToken: string };
  setAccessToken(body.accessToken);
  return true;
}

export { refresh };

/** Drops empty values so blank filter inputs don't become `?project=`. */
export function toQuery(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** A `<input type="date">` value is a bare day; the API wants an ISO instant. */
export function dayToIso(day: string, endOfDay = false): string | undefined {
  if (!day) return undefined;
  return `${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
}

export function filterToQuery(filter: UsageFilter & { page?: number; limit?: number }): string {
  return toQuery(filter as Record<string, string | number | undefined>);
}
