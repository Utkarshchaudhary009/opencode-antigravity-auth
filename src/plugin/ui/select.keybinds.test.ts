import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { select, type MenuItem } from './select';

/**
 * End-to-end proof that the plugin-local select() surface delivers gauge
 * keybinds ([←]/[→]/[R]/[T]) from raw stdin bytes through parseKey into the
 * onAction hook — including the in-flight guard. OpenCode's hosted
 * DialogSelect cannot do this (no raw-key hook), which is exactly why this
 * path is verified here.
 */

vi.mock('./ansi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ansi')>();
  return { ...actual, isTTY: () => true };
});

type FakeStdin = EventEmitter & {
  setRawMode: (mode: boolean) => void;
  resume: () => void;
  pause: () => void;
};

function installFakeTerminal(): { stdin: FakeStdin; writes: string[]; restore: () => void } {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};

  const writes: string[] = [];
  const stdout = {
    write: (s: string): boolean => {
      writes.push(s);
      return true;
    },
    columns: 80,
    rows: 24,
  };

  const originalStdin = process.stdin;
  const originalStdout = process.stdout;
  Object.defineProperty(process, 'stdin', { configurable: true, get: () => stdin });
  Object.defineProperty(process, 'stdout', { configurable: true, get: () => stdout });
  return {
    stdin,
    writes,
    restore: () => {
      Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin });
      Object.defineProperty(process, 'stdout', { configurable: true, value: originalStdout });
    },
  };
}

const items: MenuItem<string>[] = [
  { label: 'First', value: 'first' },
  { label: 'Second', value: 'second' },
];

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('select() gauge keybind dispatch (plugin-local surface)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers arrow and refresh keys to onAction and re-renders on true', async () => {
    const terminal = installFakeTerminal();
    try {
      const actions: string[] = [];
      const menu = select(items, {
        message: 'Gauges',
        onAction: (action) => {
          actions.push(action);
          return true; // every accepted action requests a repaint
        },
      });

      await flush();
      const writesBeforeActions = terminal.writes.length;

      terminal.stdin.emit('data', Buffer.from('\x1b[C')); // right
      await flush();
      expect(terminal.writes.length).toBeGreaterThan(writesBeforeActions); // true → re-rendered

      const writesAfterRight = terminal.writes.length;
      terminal.stdin.emit('data', Buffer.from('\x1b[D')); // left
      await flush();
      terminal.stdin.emit('data', Buffer.from('r')); // refresh
      await flush();

      expect(actions).toEqual(['right', 'left', 'refresh']);
      expect(terminal.writes.length).toBeGreaterThan(writesAfterRight);

      terminal.stdin.emit('data', Buffer.from('\x03')); // escape → close
      await expect(menu).resolves.toBe(null);
    } finally {
      terminal.restore();
    }
  });

  it('ignores action keys while a previous action is still in flight (P2-5)', async () => {
    const terminal = installFakeTerminal();
    try {
      let releaseFirst!: (value: boolean) => void;
      const firstCall = new Promise<boolean>((resolve) => {
        releaseFirst = resolve;
      });
      const calls: string[] = [];
      const menu = select(items, {
        message: 'Gauges',
        onAction: (action) => {
          calls.push(action);
          if (calls.length === 1) return firstCall;
          return false;
        },
      });

      terminal.stdin.emit('data', Buffer.from('\x1b[C')); // starts in-flight
      await flush();
      terminal.stdin.emit('data', Buffer.from('\x1b[C')); // ignored while in flight
      terminal.stdin.emit('data', Buffer.from('r')); // ignored while in flight
      await flush();
      expect(calls).toEqual(['right']);

      releaseFirst(true);
      await flush();
      terminal.stdin.emit('data', Buffer.from('r')); // accepted after completion
      await flush();
      expect(calls).toEqual(['right', 'refresh']);

      terminal.stdin.emit('data', Buffer.from('\x03'));
      await expect(menu).resolves.toBe(null);
    } finally {
      terminal.restore();
    }
  });
});
