import { describe, it, expect, vi } from "vitest";
vi.mock("../src/native-map/world-worker?worker", () => ({ default: class {} }));
import { NativeWorldClient } from "../src/native-map/client";

class FakeWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: any[] = [];
  terminated = false;
  postMessage(value: any) { this.messages.push(value); }
  terminate() { this.terminated = true; }
  reply(id: number, value: any = {}) { this.onmessage?.({ data: { id, ok: true, ...value } }); }
}

describe("native generation worker lifecycle", () => {
  it('delivers terrain early and joins final placements using the same buffer objects', async () => {
    const worker = new FakeWorker(), client = new NativeWorldClient(() => worker as unknown as Worker);
    const ready = client.prepare(); worker.reply(1); await ready;
    const early = vi.fn(), pending = client.generate({ seed: 618 }, undefined, early);
    let complete = false; void pending.then(() => complete = true);
    await Promise.resolve(); expect(worker.messages.at(-1).streamTerrain).toBe(true);
    const terrain = { seed: 618, ngPlus: 0, gameMode: 'normal', worldSize: 70, worldCenter: 35,
      biomeData: { pixels: new Uint32Array([1]) }, tileLayers: [{ buffer: new Uint8Array([2]) }], elevatorShafts: [] };
    worker.onmessage?.({ data: { id: 2, type: 'terrain', terrain } }); await Promise.resolve();
    expect(early).toHaveBeenCalledExactlyOnceWith(terrain); expect(complete).toBe(false);
    worker.reply(2, { terrainTransferred: true, world: { seed: 618, ngPlus: 0, gameMode: 'normal', worldSize: 70, worldCenter: 35, regions: [] } });
    const world = await pending;
    expect(world.tileLayers).toBe(terrain.tileLayers); expect(world.biomeData).toBe(terrain.biomeData);
    expect(world.regions).toEqual([]); client.dispose();
  });

  it('ignores cancelled terrain notifications and rejects an incomplete transfer protocol', async () => {
    const worker = new FakeWorker(), client = new NativeWorldClient(() => worker as unknown as Worker);
    const ready = client.prepare(); worker.reply(1); await ready;
    const early = vi.fn(), lifetime = new AbortController(), pending = client.generate({ seed: 1 }, lifetime.signal, early);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); await Promise.resolve();
    lifetime.abort(); await cancelled;
    worker.onmessage?.({ data: { id: 2, type: 'terrain', terrain: { seed: 1 } } }); expect(early).not.toHaveBeenCalled();
    const next = client.generate({ seed: 2 }, undefined, early), rejected = expect(next).rejects.toThrow('completion mismatch');
    await Promise.resolve(); worker.reply(3, { terrainTransferred: true, world: { seed: 2 } }); await rejected;
    client.dispose();
  });

  it('rejects wrong-seed terrain or a failing preparation callback and cancels its scan', async () => {
    for (const wrongSeed of [false, true]) {
      const worker = new FakeWorker(), client = new NativeWorldClient(() => worker as unknown as Worker);
      const ready = client.prepare(); worker.reply(1); await ready;
      const pending = client.generate({ seed: 618 }, undefined, () => { throw new Error('Preparation failed'); });
      const rejected = expect(pending).rejects.toThrow(wrongSeed ? 'Unexpected native terrain' : 'Preparation failed');
      await Promise.resolve(); worker.onmessage?.({ data: { id: 2, type: 'terrain', terrain: { seed: wrongSeed ? 1 : 618 } } });
      await rejected; expect(worker.messages.at(-1)).toEqual({ type: 'cancel', id: 2 }); client.dispose();
    }
  });

  it("prepares once and reuses its worker across seeds", async () => {
    const worker = new FakeWorker(), create = vi.fn(() => worker as unknown as Worker);
    const client = new NativeWorldClient(create);
    const a = client.prepare(), b = client.prepare();
    expect(a).toBe(b); expect(worker.messages).toEqual([{ id: 1, type: "prepare", request: undefined }]);
    worker.reply(1); await a;
    for (const seed of [1103, 11033]) {
      const pending = client.generate({ seed }); await Promise.resolve();
      const message = worker.messages.at(-1); expect(message.request.seed).toBe(seed);
      worker.reply(message.id, { world: { seed } }); expect(await pending).toEqual({ seed });
    }
    expect(create).toHaveBeenCalledTimes(1); client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("cancels a request without accepting its late result or poisoning the next seed", async () => {
    const worker = new FakeWorker(), client = new NativeWorldClient(() => worker as unknown as Worker);
    const ready = client.prepare(); worker.reply(1); await ready;
    const controller = new AbortController();
    const old = client.generate({ seed: 1 }, controller.signal); await Promise.resolve();
    const rejection = expect(old).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejection;
    expect(worker.messages.at(-1)).toEqual({ type: "cancel", id: 2 });
    worker.reply(2, { world: { seed: 1 } });
    const next = client.generate({ seed: 2 }); await Promise.resolve(); worker.reply(3, { world: { seed: 2 } });
    expect(await next).toEqual({ seed: 2 }); client.dispose();
  });

  it("rejects failures and recreates the worker without accepting stale worker errors", async () => {
    const workers: FakeWorker[] = [], client = new NativeWorldClient(() => {
      const w = new FakeWorker(); workers.push(w); return w as unknown as Worker;
    });
    const pending = client.prepare(), failure = expect(pending).rejects.toThrow("bad asset");
    workers[0].onmessage?.({ data: { id: 1, ok: false, error: "bad asset" } }); await failure;
    expect(workers[0].terminated).toBe(true);
    const retry = client.prepare(); workers[0].onerror?.({ message: "stale" });
    workers[1].reply(2); await retry; expect(workers[1].terminated).toBe(false); client.dispose();
  });
});
