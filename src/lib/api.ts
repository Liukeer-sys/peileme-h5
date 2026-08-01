import type {
  PolicyApiResult,
  PolicyCalculateRequest,
  PolicyHistoryDetail,
  PolicyHistoryItem,
  PolicyRegion,
  PolicyShare,
  PolicyShareStatus
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
let refreshController: AbortController | null = null;
let refreshBlocked = false;
let authEpoch = 0;
const activeAuthTransitions = new Set<number>();

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
  if (refreshBlocked) return false;
  if (!refreshPromise) {
    const capturedEpoch = authEpoch;
    const controller = new AbortController();
    refreshController = controller;
    const currentRefresh = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
      headers: {
        "x-visitor-id": visitorId,
        "x-session-id": sessionId,
        ...csrfHeader()
      }
    })
      .then(async (response) => {
        if (capturedEpoch !== authEpoch || refreshBlocked) return false;
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
        if (refreshPromise === currentRefresh) {
          refreshPromise = null;
          refreshController = null;
        }
      });
    refreshPromise = currentRefresh;
  }
  return refreshPromise;
};

export const beginAuthTransition = async () => {
  refreshBlocked = true;
  authEpoch += 1;
  const transitionEpoch = authEpoch;
  activeAuthTransitions.add(transitionEpoch);
  const pendingRefresh = refreshPromise;
  refreshController?.abort();
  if (pendingRefresh) await pendingRefresh.catch(() => false);
  return transitionEpoch;
};

export const completeAuthTransition = (transitionEpoch: number) => {
  activeAuthTransitions.delete(transitionEpoch);
  if (activeAuthTransitions.size === 0) refreshBlocked = false;
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

type AiJobStreamOptions = {
  signal?: AbortSignal;
  onChunk: (text: string) => void;
};

const waitBeforeStreamReconnect = (signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, 400);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

export async function streamAiJob<T>(
  jobId: string,
  options: AiJobStreamOptions
): Promise<T> {
  if (!accessToken) await refreshSession();
  let after = 0;
  let reconnects = 0;

  while (reconnects <= 8) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const makeRequest = () => fetch(
      `/api/ai/jobs/${encodeURIComponent(jobId)}/stream?after=${after}`,
      {
        credentials: "include",
        signal: options.signal,
        headers: {
          Accept: "text/event-stream",
          "x-visitor-id": visitorId,
          "x-session-id": sessionId,
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
        }
      }
    );
    let response = await makeRequest();
    if (response.status === 401 && await refreshSession()) {
      response = await makeRequest();
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as {
        error?: string;
        message?: string;
      };
      throw new ApiError(
        response.status,
        error.error || "AI_STREAM_FAILED",
        error.message || "AI 回复连接失败，请稍后重试"
      );
    }
    if (!response.body) {
      throw new ApiError(502, "AI_STREAM_EMPTY", "AI 回复连接未返回内容");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const next = await reader.read();
        buffer += decoder.decode(next.value, { stream: !next.done }).replace(/\r\n/g, "\n");
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (!block || block.startsWith(":")) continue;
          const lines = block.split("\n");
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (id && /^\d+$/.test(id)) after = Math.max(after, Number(id));
          if (event === "chunk" && data) {
            const payload = JSON.parse(data) as { text?: unknown };
            if (typeof payload.text === "string") options.onChunk(payload.text);
          }
          if (event === "done" && data) return JSON.parse(data) as T;
        }
        if (next.done) break;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
    reconnects += 1;
    if (reconnects > 8) break;
    await waitBeforeStreamReconnect(options.signal);
  }
  throw new ApiError(
    504,
    "AI_STREAM_RECONNECT_EXHAUSTED",
    "AI 回复连接中断，任务仍会在后台保存，请从历史记录查看"
  );
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

export const listPolicyShares = (assessmentId: string) =>
  api<{ items: PolicyShareStatus[] }>(
    `/api/policy/history/${encodeURIComponent(assessmentId)}/shares`,
    { auth: true }
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

export async function downloadFromApi(
  path: string,
  fallbackName: string,
  signal?: AbortSignal
) {
  if (!accessToken) await refreshSession();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const makeRequest = () =>
    fetch(path, {
      credentials: "include",
      signal,
      headers: {
        "x-visitor-id": visitorId,
        "x-session-id": sessionId,
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...csrfHeader()
      }
    });
  let response = await makeRequest();
  if (response.status === 401 && (await refreshSession())) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    response = await makeRequest();
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
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
  const blob = await response.blob();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const url = URL.createObjectURL(blob);
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
