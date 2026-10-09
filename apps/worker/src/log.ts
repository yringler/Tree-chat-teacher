// The Worker's structured logs: one JSON object per line, `event` first, so
// Workers Logs can filter and count by event and field.

export type LogLevel = 'info' | 'warn' | 'error';

/** An Error as JSON keeps its name, message and stack (JSON.stringify alone writes `{}`). */
function withErrors(_key: string, value: unknown): unknown {
  return value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : value;
}

/** Writes `{ event, ...fields }` as one line on the console method of `level`. */
export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ event, ...fields }, withErrors);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
