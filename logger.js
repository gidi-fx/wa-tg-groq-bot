/**
 * Shared error logger. GramJS and Axios both throw objects that stringify to
 * "{}", which hides the real cause - always print errorMessage, message, code
 * and the stack.
 */
export function logError(scope, err) {
  if (!err) {
    console.error(`${scope}: unknown error`);
    return;
  }

  const parts = [
    `errorMessage=${err.errorMessage || '(none)'}`,
    `message=${err.message || '(none)'}`,
    `code=${err.code === undefined ? '(none)' : err.code}`,
  ];
  console.error(`${scope}: ${parts.join(' | ')}`);

  if (err.stack) {
    console.error(`${scope} stack:\n${err.stack}`);
  } else {
    console.error(`${scope} raw:`, err);
  }
}
