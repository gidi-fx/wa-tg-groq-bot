export class AppError extends Error {
  constructor(message, status = 400, code = 'app_error', details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Best-effort human readable message for axios/fetch/Supabase errors. */
export function errorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.response && err.response.data) {
    const data = err.response.data;
    if (typeof data === 'string') return data;
    return data.message || data.error?.message || data.error || JSON.stringify(data);
  }
  return err.message || String(err);
}
