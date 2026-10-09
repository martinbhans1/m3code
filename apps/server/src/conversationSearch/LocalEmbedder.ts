import { Worker } from "node:worker_threads";

/**
 * Runs the local embedding model on a worker thread.
 *
 * On the server's own thread one 32-chunk batch held the event loop for 2-3s,
 * and the background indexer ran one batch after another while any conversation
 * was active. Every request, socket ping and database read in the server waited
 * behind it. Off-thread the server keeps answering while the model works.
 *
 * The worker is evaluated from source rather than loaded from a file so the
 * bundler has nothing to resolve: it only imports the transformers package,
 * which ships unbundled next to the server in both dev and the desktop build.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
let model = null;
const loadModel = () => {
  model ??= import(workerData.transformersUrl).then((transformers) => {
    transformers.env.cacheDir = workerData.cacheDir;
    transformers.env.allowRemoteModels = true;
    return transformers.pipeline("feature-extraction", workerData.model, { dtype: workerData.dtype });
  });
  // A failed load (offline first run, a corrupt download) must not stick.
  model.catch(() => { model = null; });
  return model;
};
parentPort.on("message", async ({ id, texts }) => {
  try {
    const extractor = await loadModel();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const rows = output.tolist();
    const dimensions = rows[0]?.length ?? 0;
    const flat = new Float32Array(rows.length * dimensions);
    rows.forEach((row, index) => flat.set(row, index * dimensions));
    parentPort.postMessage({ id, ok: true, dimensions, buffer: flat.buffer }, [flat.buffer]);
  } catch (cause) {
    parentPort.postMessage({ id, ok: false, message: String(cause?.stack ?? cause) });
  }
});
`;

export type EmbeddingPriority = "query" | "document";

interface PendingRequest {
  readonly id: number;
  readonly texts: ReadonlyArray<string>;
  readonly resolve: (embeddings: Float32Array[]) => void;
  readonly reject: (error: Error) => void;
}

type WorkerReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly dimensions: number;
      readonly buffer: ArrayBuffer;
    }
  | { readonly id: number; readonly ok: false; readonly message: string };

export interface LocalEmbedderOptions {
  readonly model: string;
  readonly dtype: string;
  readonly cacheDir: string;
}

export interface LocalEmbedder {
  /**
   * Embed `texts` in one model call. Query requests go ahead of every queued
   * document batch, so a search typed while the indexer is busy waits for at
   * most the batch already running.
   */
  readonly embed: (
    texts: ReadonlyArray<string>,
    priority: EmbeddingPriority,
  ) => Promise<Float32Array[]>;
  readonly close: () => Promise<void>;
}

function splitEmbeddings(reply: { dimensions: number; buffer: ArrayBuffer }, count: number) {
  const flat = new Float32Array(reply.buffer);
  return Array.from({ length: count }, (_, index) =>
    flat.slice(index * reply.dimensions, (index + 1) * reply.dimensions),
  );
}

export function makeLocalEmbedder(options: LocalEmbedderOptions): LocalEmbedder {
  const queries: PendingRequest[] = [];
  const documents: PendingRequest[] = [];
  let running: PendingRequest | null = null;
  let worker: Worker | null = null;
  let nextId = 0;
  let closed = false;

  const failRunning = (error: Error) => {
    const current = running;
    running = null;
    current?.reject(error);
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const created = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        transformersUrl: import.meta.resolve("@huggingface/transformers"),
        cacheDir: options.cacheDir,
        model: options.model,
        dtype: options.dtype,
      },
    });
    // Idle embedding must never be what keeps the server process alive.
    created.unref();
    created.on("message", (reply: WorkerReply) => {
      const current = running;
      if (!current || current.id !== reply.id) return;
      running = null;
      if (reply.ok) current.resolve(splitEmbeddings(reply, current.texts.length));
      else current.reject(new Error(reply.message));
      pump();
    });
    // A crashed worker takes only the request it was running with it; the next
    // request starts a fresh one.
    const onDeath = (error: Error) => {
      if (worker === created) worker = null;
      failRunning(error);
      pump();
    };
    created.on("error", onDeath);
    created.on("exit", (code) => onDeath(new Error(`Embedding worker exited with code ${code}.`)));
    worker = created;
    return created;
  };

  const pump = () => {
    if (running || closed) return;
    const next = queries.shift() ?? documents.shift();
    if (!next) return;
    running = next;
    try {
      ensureWorker().postMessage({ id: next.id, texts: next.texts });
    } catch (cause) {
      failRunning(cause instanceof Error ? cause : new Error(String(cause)));
      pump();
    }
  };

  return {
    embed: (texts, priority) =>
      new Promise<Float32Array[]>((resolve, reject) => {
        if (closed) {
          reject(new Error("The embedding worker is closed."));
          return;
        }
        if (texts.length === 0) {
          resolve([]);
          return;
        }
        nextId += 1;
        (priority === "query" ? queries : documents).push({
          id: nextId,
          texts: [...texts],
          resolve,
          reject,
        });
        pump();
      }),
    close: async () => {
      closed = true;
      const error = new Error("The embedding worker is closed.");
      for (const request of [...queries.splice(0), ...documents.splice(0)]) request.reject(error);
      failRunning(error);
      const current = worker;
      worker = null;
      await current?.terminate();
    },
  };
}
