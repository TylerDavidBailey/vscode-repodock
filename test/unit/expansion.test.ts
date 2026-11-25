import { describe, expect, it } from 'vitest';
import { ExpansionStore } from '../../src/ext/expansion';
import { fakeMemento } from './helpers/memento';

describe('ExpansionStore', () => {
  it('answers with the fallback for a row the user never toggled', () => {
    const store = new ExpansionStore(fakeMemento());
    expect(store.isExpanded('section:pinned', true)).toBe(true);
    expect(store.isExpanded('all:/srv/repo', false)).toBe(false);
  });

  it('remembers a collapse and an expand, each overriding the fallback', async () => {
    const store = new ExpansionStore(fakeMemento());
    await store.set('section:pinned', false);
    await store.set('all:/srv/repo', true);
    expect(store.isExpanded('section:pinned', true)).toBe(false);
    expect(store.isExpanded('all:/srv/repo', false)).toBe(true);
  });

  it('keeps the latest choice when a row is toggled back', async () => {
    const store = new ExpansionStore(fakeMemento());
    await store.set('section:recent', false);
    await store.set('section:recent', true);
    expect(store.isExpanded('section:recent', false)).toBe(true);
  });

  it('survives a new store over the same storage, which is what a new window is', async () => {
    const memento = fakeMemento();
    await new ExpansionStore(memento).set('section:all', false);
    expect(new ExpansionStore(memento).isExpanded('section:all', true)).toBe(false);
  });

  it('does not write when the state is already what was stored', async () => {
    const memento = fakeMemento();
    const store = new ExpansionStore(memento);
    await store.set('section:all', false);
    const before = memento.get('repodock.expansion');
    await store.set('section:all', false);
    // the same object: an unchanged state must not cost a storage write per click
    expect(memento.get('repodock.expansion')).toBe(before);
  });

  it('drops the rows touched longest ago once it holds 500', async () => {
    const store = new ExpansionStore(fakeMemento());
    for (let index = 0; index < 500; index++) await store.set(`folder:/srv/${index}`, false);
    // touching the oldest again makes it the newest, so the next write evicts row 1 instead
    await store.set('folder:/srv/0', true);
    await store.set('folder:/srv/new', false);

    expect(store.isExpanded('folder:/srv/0', false)).toBe(true);
    expect(store.isExpanded('folder:/srv/new', true)).toBe(false);
    expect(store.isExpanded('folder:/srv/1', true)).toBe(true); // evicted: back to the fallback
    expect(store.isExpanded('folder:/srv/2', true)).toBe(false);
  });
});
