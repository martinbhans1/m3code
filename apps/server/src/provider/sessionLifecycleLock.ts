import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Serialize lifecycle changes for one thread without blocking unrelated threads. */
export function makeSessionLifecycleLock() {
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

  return <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let entry = locks.get(threadId);
      if (!entry) {
        entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        locks.set(threadId, entry);
      }
      const lock = entry;
      lock.users += 1;
      return lock.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lock.users -= 1;
            if (lock.users === 0) locks.delete(threadId);
          }),
        ),
      );
    });
}
