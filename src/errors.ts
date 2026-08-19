/**
 * An error with a message that is safe and useful to show to a user.
 * Anything thrown as an `AppError` is printed without a stack trace.
 */
export class AppError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "AppError";
    this.hint = hint;
  }
}

/** Extracts a readable message from an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof AppError) {
    return error.hint ? `${error.message}\n${error.hint}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
