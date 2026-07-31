import net from "node:net";
import type {
  NextFunction,
  Request,
  RequestHandler,
  Response
} from "express";

export type ProductChannel = "main" | "ai";
export type ProductHostResolver = (
  rawHost: string | undefined
) => ProductChannel | null;

declare global {
  namespace Express {
    interface Request {
      readonly productChannel?: ProductChannel;
    }
  }
}

const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const canonicalIpv6 = (address: string) => {
  const hostname = new URL(`http://[${address}]`).hostname;
  return hostname.slice(1, -1).toLowerCase();
};

export const normalizeProductHost = (
  rawHost: string | undefined
): string | null => {
  if (
    !rawHost ||
    rawHost !== rawHost.trim() ||
    /[\u0000-\u001f\u007f]/.test(rawHost) ||
    rawHost.includes(",") ||
    /[\/\\@?#]/.test(rawHost) ||
    rawHost.includes("://") ||
    rawHost.endsWith(":")
  ) {
    return null;
  }
  const validPort = (port: string | undefined) => {
    if (port === undefined) return true;
    if (!/^\d{1,5}$/.test(port)) return false;
    const numericPort = Number(port);
    return numericPort >= 1 && numericPort <= 65_535;
  };
  if (rawHost.startsWith("[")) {
    const match = rawHost.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!match || !validPort(match[2]) || net.isIP(match[1]) !== 6) {
      return null;
    }
    return canonicalIpv6(match[1]);
  }
  if (rawHost.includes("[") || rawHost.includes("]")) return null;
  const authority = rawHost.match(/^([^:]+)(?::(\d+))?$/);
  if (!authority || !validPort(authority[2])) return null;
  let hostname = authority[1].toLowerCase();
  const hadTrailingDot = hostname.endsWith(".");
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!hostname || hostname.includes("..")) return null;
  if (net.isIP(hostname) === 4) {
    return hadTrailingDot ? null : hostname;
  }
  if (
    /^[0-9.]+$/.test(hostname) ||
    hostname.split(".").some((label) => /^0x[0-9a-f]+$/i.test(label))
  ) {
    return null;
  }
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    labels.some((label) => !hostnameLabel.test(label))
  ) {
    return null;
  }
  return hostname;
};

export const parseProductHostAllowlist = (
  input: string,
  name: string
): string[] => {
  const entries = input.split(",");
  if (!entries.length || entries.some((entry) => !entry.trim())) {
    throw new Error(`${name} contains an empty host entry`);
  }
  const normalized = entries.map((entry) => {
    const host = normalizeProductHost(entry.trim());
    if (!host) throw new Error(`${name} contains an invalid host entry`);
    return host;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${name} contains a duplicate host entry`);
  }
  return normalized;
};

export const createProductHostResolver = (
  configuredMainHosts: readonly string[],
  configuredAiHosts: readonly string[]
): ProductHostResolver => {
  const canonicalHosts = (hosts: readonly string[], name: string) => {
    if (!hosts.length) {
      throw new Error(`${name} must contain at least one host`);
    }
    const validated = hosts.map((host) => {
      const ipVersion = net.isIP(host);
      const normalized =
        ipVersion === 6
          ? canonicalIpv6(host)
          : ipVersion === 4
            ? host
            : normalizeProductHost(host);
      if (!normalized || (ipVersion === 0 && normalized !== host)) {
        throw new Error(`${name} must contain normalized host entries`);
      }
      return normalized;
    });
    if (new Set(validated).size !== validated.length) {
      throw new Error(`${name} contains a duplicate host entry`);
    }
    return new Set(validated);
  };
  const mainHosts = canonicalHosts(
    configuredMainHosts,
    "MAIN_PRODUCT_HOSTS"
  );
  const aiHosts = canonicalHosts(configuredAiHosts, "AI_PRODUCT_HOSTS");
  for (const host of mainHosts) {
    if (aiHosts.has(host)) {
      throw new Error(
        `Product host ${host} cannot be configured in both channel allowlists`
      );
    }
  }
  return (rawHost) => {
    const host = normalizeProductHost(rawHost);
    if (!host) return null;
    if (mainHosts.has(host)) return "main";
    if (aiHosts.has(host)) return "ai";
    return null;
  };
};

export const attachProductChannel = (
  resolveHost: ProductHostResolver
): RequestHandler =>
  (request, _response, next) => {
    const rawHostValues: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === "host") {
        rawHostValues.push(request.rawHeaders[index + 1] ?? "");
      }
    }
    const distinctHostValues = request.headersDistinct?.host;
    const hasExactlyOneHost =
      rawHostValues.length === 1 &&
      (!distinctHostValues || distinctHostValues.length === 1) &&
      request.headers.host === rawHostValues[0];
    const channel = hasExactlyOneHost
      ? resolveHost(rawHostValues[0])
      : null;
    if (channel) {
      Object.defineProperty(request, "productChannel", {
        configurable: false,
        enumerable: true,
        value: channel,
        writable: false
      });
    }
    next();
  };

const productHostNotFound = (request: Request, response: Response) => {
  const logger = (
    request as Request & {
      log?: { warn: (detail: unknown, message: string) => void };
    }
  ).log;
  logger?.warn(
    { receivedHost: request.headers.host },
    "product host rejected"
  );
  response.status(404).json({
    error: "PRODUCT_HOST_NOT_FOUND",
    message: "产品站点不存在"
  });
};

export const requireProductHost = (
  request: Request,
  response: Response,
  next: NextFunction
) => {
  if (!request.productChannel) {
    productHostNotFound(request, response);
    return;
  }
  next();
};

export const requireAiProductHost = (
  request: Request,
  response: Response,
  next: NextFunction
) => {
  if (!request.productChannel) {
    productHostNotFound(request, response);
    return;
  }
  if (request.productChannel !== "ai") {
    const logger = (
      request as Request & {
        log?: { warn: (detail: unknown, message: string) => void };
      }
    ).log;
    logger?.warn(
      {
        productChannel: request.productChannel,
        path: request.originalUrl
      },
      "AI-only product capability rejected"
    );
    response.status(404).json({
      error: "NOT_FOUND",
      message: "接口不存在"
    });
    return;
  }
  next();
};
