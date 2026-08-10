export type PublicErrorCode =
  | "invalid_request"
  | "invalid_credential"
  | "rate_limited"
  | "email_already_bound"
  | "rebind_confirmation_required"
  | "rebind_limit_reached"
  | "capacity_full"
  | "temporarily_unavailable"
  | "not_found"
  | "unauthorized"
  | "disabled";

export class AppError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string,
    readonly status = 400,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export function toPublicError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    "temporarily_unavailable",
    "unexpected internal error",
    503,
    true,
    { cause: error },
  );
}
