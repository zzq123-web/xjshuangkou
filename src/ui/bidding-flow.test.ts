import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../game/types.js';

vi.mock('../game/deck.js', async importOriginal => {
  const deck = await importOriginal<typeof import('../game/deck.js')>();
  return { ...deck, shuffleCards: (cards: readonly Card[]) => [...cards] };
});

class ClickTarget {
  readonly dataset: Record<string, string>;
  constructor(dataset: Record<string, string>) { this.dataset = dataset; }
  closest(selector: string): ClickTarget | null {
    const keys: Record<string, string> = {
      '[data-action]': 'action', '[data-card]': 'card', '[data-count]': 'count', '[data-bid-viewer]': 'bidViewer'
    };
    return this.dataset[keys[selector]] === undefined ? null : this;
  }
}

const listeners = new Map<string, (event: { target: ClickTarget }) => void>();
const app = {
  innerHTML: '',
  addEventListener: (name: string, listener: (event: { target: ClickTarget }) => void) => { listeners.set(name, listener); }
};
function click(dataset: Record<string, string>): void {
  const listener = listeners.get('click');
  if (!listener) throw new Error('UI click handler missing.');
  listener({ target: new ClickTarget(dataset) });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  app.innerHTML = '';
  listeners.clear();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
  vi.stubGlobal('document', { querySelector: () => app });
  vi.stubGlobal('Element', ClickTarget);
  vi.stubGlobal('window', {
    location: { search: '' }, confirm: () => true,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('local bidding race', () => {
  it('lets all bots respond before the human and preserves the human selection', async () => {
    await import('./main.js');
    click({ action: 'start-local' });
    click({ card: 'clubs-K-1' });
    click({ card: 'clubs-K-2' });
    expect(app.innerHTML).toContain('已选2张');

    await vi.advanceTimersByTimeAsync(8000);
    expect(app.innerHTML).toContain('3/4名玩家已完成选择');
    expect(app.innerHTML).toContain('已选2张');
    expect(app.innerHTML).toContain('本轮已锁定6张拖拉机');
    expect(app.innerHTML).toContain('抢叫庄');

    click({ action: 'clear' });
    for (const rank of ['A', 'K', 'Q']) {
      click({ card: `clubs-${rank}-1` });
      click({ card: `clubs-${rank}-2` });
    }
    click({ action: 'bid' });
    expect(app.innerHTML).toContain('争庄牌已统一揭晓');
  });

  it('lets the human lock pairs first and waits for all bots before choosing the dealer', async () => {
    await import('./main.js');
    click({ action: 'start-local' });
    click({ card: 'clubs-K-1' });
    click({ card: 'clubs-K-2' });
    click({ action: 'bid' });
    expect(app.innerHTML).toContain('本轮已锁定对子（2张）');
    expect(app.innerHTML).toContain('1/4名玩家已完成选择');
    expect(app.innerHTML).not.toContain('成为庄家');

    await vi.advanceTimersByTimeAsync(8000);
    expect(app.innerHTML).toContain('玩家1成为庄家');
    expect(app.innerHTML).not.toContain('The bid must match');
  });
});
