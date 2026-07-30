import type {
  PolicyApiResult,
  PolicyCalculateRequest,
  PolicyHistoryDetail,
  PolicyHistoryItem,
  PolicyRegion,
  PolicyShare
} from "../types";

const VISITOR_KEY = "peileme-visitor-id";
const SESSION_KEY = "peileme-session-id";

const createId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

const persistentId = (key: string, prefix: string, storage: Storage) => {
  let value = storage.getItem(key);
  if (!value) {
    value = createId(prefix);
    storage.setItem(key, value);
  }
  return value;
};

export const visitorId = persistentId(VISITOR_KEY, "visitor", window.localStorage);
export const sessionId = persistentId(SESSION_KEY, "session", window.sessionStorage);

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

const csrfHeader = (): Record<string, string> => {
  const encodedToken = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("peileme_csrf="))
    ?.slice("peileme_csrf=".length);
  if (!encodedToken) return {};
  try {
    return { "x-csrf-token": decodeURIComponent(encodedToken) };
  } catch {
    return {};
  }
};

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};

const refreshSession = async () => {
  if (!refreshPromise) {
    refreshPromise = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: {
        "x-visitor-id": visitorId,
        "x-session-id": sessionId,
        ...csrfHeader()
      }
    })
      .then(async (response) => {
        if (response.status === 204) {
          setAccessToken(null);
          return false;
        }
        if (!response.ok) {
          setAccessToken(null);
          return false;
        }
        const data = (await response.json()) as { accessToken: string };
        setAccessToken(data.accessToken);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
};

type ApiOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  auth?: boolean;
  retry?: boolean;
};

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, auth = false, retry = true, headers, ...requestOptions } = options;
  if (auth && !accessToken) await refreshSession();

  const response = await fetch(path, {
    ...requestOptions,
    credentials: "include",
    headers: {
      ...(body instanceof FormData ? {} : body === undefined ? {} : { "content-type": "application/json" }),
      "x-visitor-id": visitorId,
      "x-session-id": sessionId,
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...csrfHeader(),
      ...headers
    },
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body)
  });

  if (response.status === 401 && auth && retry && (await refreshSession())) {
    return api<T>(path, { ...options, retry: false });
  }

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      details?: unknown;
    };
    throw new ApiError(
      response.status,
      error.error || "REQUEST_FAILED",
      error.message || "请求失败，请稍后重试",
      error.details
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

type PolicyApiWireResult = Omit<PolicyApiResult, "accuracyLevel"> & {
  accuracy?: PolicyApiResult["accuracyLevel"];
  accuracyLevel?: PolicyApiResult["accuracyLevel"];
};

export const listPolicyRegions = async (year: number, signal?: AbortSignal) =>
  (
    await api<{ items: PolicyRegion[] }>(
      `/api/policy/regions?year=${encodeURIComponent(String(year))}`,
      { signal }
    )
  ).items;

export const calculatePolicy = async (
  body: PolicyCalculateRequest,
  signal?: AbortSignal
): Promise<PolicyApiResult> => {
  const response = await api<PolicyApiWireResult>("/api/policy/calculate", {
    method: "POST",
    auth: true,
    body,
    signal
  });
  return {
    ...response,
    accuracyLevel:
      response.accuracyLevel || response.accuracy || "unsupported"
  };
};

export const listPolicyHistory = (
  page = 1,
  pageSize = 20
) =>
  api<{
    items: PolicyHistoryItem[];
    pagination: { page: number; pageSize: number; total: number };
  }>(
    `/api/policy/history?page=${encodeURIComponent(String(page))}&pageSize=${encodeURIComponent(String(pageSize))}`,
    { auth: true }
  );

export const getPolicyHistory = (id: string) =>
  api<PolicyHistoryDetail>(
    `/api/policy/history/${encodeURIComponent(id)}`,
    { auth: true }
  );

export const createPolicyShare = (
  assessmentId: string,
  expiresInDays = 7
) =>
  api<PolicyShare>(
    `/api/policy/history/${encodeURIComponent(assessmentId)}/share`,
    {
      method: "POST",
      auth: true,
      body: { expiresInDays }
    }
  );

export const revokePolicyShare = (shareId: string) =>
  api<void>(`/api/policy/shares/${encodeURIComponent(shareId)}`, {
    method: "DELETE",
    auth: true
  });

export const getSharedPolicyResult = async (
  token: string
): Promise<PolicyApiResult> => {
  const response = await api<
    Omit<PolicyApiWireResult, "assessmentId"> & {
      shareId: string;
      expiresAt: string;
    }
  >(`/api/policy/share/${encodeURIComponent(token)}`);
  return {
    ...response,
    assessmentId: response.shareId,
    accuracyLevel:
      response.accuracyLevel || response.accuracy || "unsupported"
  };
};

export async function downloadFromApi(path: string, fallbackName: string) {
  if (!accessToken) await refreshSession();
  const makeRequest = () =>
    fetch(path, {
      credentials: "include",
      headers: {
        "x-visitor-id": visitorId,
        "x-session-id": sessionId,
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...csrfHeader()
      }
    });
  let response = await makeRequest();
  if (response.status === 401 && (await refreshSession())) {
    response = await makeRequest();
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(
      response.status,
      error.error || "DOWNLOAD_FAILED",
      error.message || "下载失败，请稍后重试"
    );
  }
  const disposition = response.headers.get("content-disposition") || "";
  const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const basicName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const filename = decodeURIComponent(utf8Name || basicName || fallbackName);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const initializeSession = refreshSession;

type AnalyticsEvent = {
  name: string;
  path?: string;
  properties?: Record<string, unknown>;
  occurredAt?: string;
};

let eventQueue: AnalyticsEvent[] = [];
let flushTimer: number | undefined;

export const flushEvents = async () => {
  if (!eventQueue.length) return;
  const events = eventQueue.splice(0, 50);
  try {
    await api("/api/events/batch", { method: "POST", body: { events } });
  } catch {
    eventQueue = [...events, ...eventQueue].slice(-100);
  }
};

export const track = (name: string, properties: Record<string, unknown> = {}) => {
  eventQueue.push({
    name,
    path: window.location.pathname,
    properties,
    occurredAt: new Date().toISOString()
  });
  if (eventQueue.length >= 10) {
    void flushEvents();
    return;
  }
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flushEvents(), 900);
};

window.addEventListener("pagehide", () => {
  if (!eventQueue.length) return;
  const payload = JSON.stringify({ events: eventQueue.splice(0, 50) });
  void fetch("/api/events/batch", {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: {
      "content-type": "application/json",
      "x-visitor-id": visitorId,
      "x-session-id": sessionId,
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...csrfHeader()
    },
    body: payload
  });
});
