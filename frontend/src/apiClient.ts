const API_ROOT = "/api";

export const AUTH_EXPIRED_EVENT = "clipflow-auth-expired";

type ErrorDetail = {
  code?: string;
  message?: string;
  operation?: string;
  help_url?: string | null;
  retryable?: boolean;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly operation?: string;
  readonly helpUrl?: string;
  readonly retryable: boolean;

  constructor(message: string, status: number, detail: ErrorDetail = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = detail.code;
    this.operation = detail.operation;
    this.helpUrl = detail.help_url || undefined;
    this.retryable = detail.retryable === true;
  }
}

function errorDetail(body: string): ErrorDetail {
  try {
    const parsed = JSON.parse(body) as { detail?: string | ErrorDetail };
    if (typeof parsed.detail === "string") return { message: parsed.detail };
    if (parsed.detail && typeof parsed.detail === "object") return parsed.detail;
  } catch {
    // Plain-text responses are handled below.
  }
  return { message: body };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  if (!response.ok) {
    const body = await response.text();
    const detail = errorDetail(body);
    throw new ApiError(
      detail.message || `Request failed (${response.status}).`,
      response.status,
      detail,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
