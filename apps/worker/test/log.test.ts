import { afterEach, describe, expect, it, vi } from 'vitest';
import { logEvent } from '../src/log.js';

describe('logEvent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one JSON line, event first, on the console method of its level', () => {
    const spies = {
      log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    };
    logEvent('info', 'a', { n: 1 });
    logEvent('warn', 'b');
    logEvent('error', 'c', { id: 'x' });
    expect(spies.log).toHaveBeenCalledWith('{"event":"a","n":1}');
    expect(spies.warn).toHaveBeenCalledWith('{"event":"b"}');
    expect(spies.error).toHaveBeenCalledWith('{"event":"c","id":"x"}');
  });

  it('keeps an error’s name, message and stack, wherever it sits', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new TypeError('boom');
    logEvent('error', 'failed', { error: err, nested: { cause: new Error('inner') } });
    const line = JSON.parse(String(error.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line['error']).toEqual({ name: 'TypeError', message: 'boom', stack: err.stack });
    expect(line['nested']).toMatchObject({ cause: { name: 'Error', message: 'inner' } });
  });
});
