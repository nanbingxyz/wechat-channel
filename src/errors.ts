export type WeixinClientErrorCode =
  | "ERR_ACCOUNT_NOT_CONFIGURED"
  | "ERR_ACCOUNT_TOKEN_MISSING"
  | "ERR_NOT_CONNECTED"
  | "ERR_CONTEXT_TOKEN_MISSING"
  | "ERR_CONTEXT_TOKEN_EXPIRED"
  | "ERR_SESSION_EXPIRED"
  | "ERR_API_FAILURE";

export interface WeixinClientErrorOptions {
  cause?: unknown;
  apiErrorCode?: number;
  details?: unknown;
}

export class WeixinClientError extends Error {
  readonly code: WeixinClientErrorCode;
  readonly apiErrorCode?: number;
  readonly details?: unknown;

  constructor(
    code: WeixinClientErrorCode,
    message: string,
    options: WeixinClientErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WeixinClientError";
    this.code = code;
    this.apiErrorCode = options.apiErrorCode;
    this.details = options.details;
  }
}

const SESSION_EXPIRED_PATTERN = /(session.*expired|expired.*session|token.*expired|timeout)/i;

export function isSessionExpiredPayload(payload: {
  errcode?: number;
  errmsg?: string;
}): boolean {
  if (payload.errcode === -14) {
    return true;
  }
  return typeof payload.errmsg === "string" && SESSION_EXPIRED_PATTERN.test(payload.errmsg);
}

export function isSessionExpiredError(error: unknown): boolean {
  if (error instanceof WeixinClientError) {
    return error.code === "ERR_SESSION_EXPIRED";
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return SESSION_EXPIRED_PATTERN.test(error.message);
}
