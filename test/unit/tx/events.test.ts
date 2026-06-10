import { describe, expect, it } from 'vitest';
import { EventStream } from '../../../src/tx/events.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('EventStream', () => {
  it('replays history to late subscribers', async () => {
    const stream = new EventStream<number>();
    stream.push(1);
    stream.push(2);
    stream.end();
    expect(await collect(stream)).toEqual([1, 2]);
  });

  it('multicasts to several concurrent iterators', async () => {
    const stream = new EventStream<number>();
    const a = collect(stream);
    const b = collect(stream);
    stream.push(1);
    await Promise.resolve();
    stream.push(2);
    stream.end();
    expect(await a).toEqual([1, 2]);
    expect(await b).toEqual([1, 2]);
  });

  it('delivers events pushed while a consumer is waiting', async () => {
    const stream = new EventStream<string>();
    const consumer = collect(stream);
    setTimeout(() => {
      stream.push('late');
      stream.end();
    }, 5);
    expect(await consumer).toEqual(['late']);
  });

  it('ignores pushes after end', async () => {
    const stream = new EventStream<number>();
    stream.push(1);
    stream.end();
    stream.push(2);
    stream.end();
    expect(await collect(stream)).toEqual([1]);
    expect(stream.events).toEqual([1]);
  });
});
