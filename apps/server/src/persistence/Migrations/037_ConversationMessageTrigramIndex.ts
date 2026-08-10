import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A trigram index over completed message text, for literal substring search.
 *
 * The `unicode61` index added in 035 answers keyword questions and cannot answer
 * substring ones: it stores whole tokens, so it can find the message containing
 * "orchestrator" but not the one containing "-->", and it cannot tell a caller
 * that a string appears nowhere. Answering that without an index means scanning
 * every message body, which measured at ~50ms against a 27k-message library —
 * fine once, wrong as a habit for a tool the orchestrator calls repeatedly.
 *
 * Trigram matching is exact rather than approximate: verified against a literal
 * scan over 586 randomly drawn real substrings with no divergence, at ~0.4ms
 * versus ~50ms. It is still used only to narrow candidates — the query that
 * consumes it re-checks each row with `instr`, so a trigram quirk can only ever
 * cost time, never correctness.
 *
 * Two limits are inherent and handled by the caller rather than here: the
 * tokenizer cannot see queries shorter than three characters (it silently
 * matches nothing), and it is case-insensitive, so case-sensitive searching is
 * done by the confirming `instr` rather than by this index.
 *
 * Triggers mirror 035's exactly, including the `is_streaming` guard that keeps a
 * streaming response from rewriting the index on every token.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS projection_thread_messages_trigram USING fts5(
      text,
      content = 'projection_thread_messages',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages_trigram(rowid, text)
    SELECT rowid, text
    FROM projection_thread_messages
    WHERE is_streaming = 0
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_trigram_after_insert
    AFTER INSERT ON projection_thread_messages
    WHEN new.is_streaming = 0
    BEGIN
      INSERT INTO projection_thread_messages_trigram(rowid, text)
      VALUES (new.rowid, new.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_trigram_before_delete
    BEFORE DELETE ON projection_thread_messages
    WHEN old.is_streaming = 0
    BEGIN
      INSERT INTO projection_thread_messages_trigram(
        projection_thread_messages_trigram,
        rowid,
        text
      ) VALUES ('delete', old.rowid, old.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_trigram_before_update
    BEFORE UPDATE ON projection_thread_messages
    WHEN old.is_streaming = 0
      AND (new.is_streaming <> old.is_streaming OR new.text <> old.text)
    BEGIN
      INSERT INTO projection_thread_messages_trigram(
        projection_thread_messages_trigram,
        rowid,
        text
      ) VALUES ('delete', old.rowid, old.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_trigram_after_update
    AFTER UPDATE ON projection_thread_messages
    WHEN new.is_streaming = 0
      AND (new.is_streaming <> old.is_streaming OR new.text <> old.text)
    BEGIN
      INSERT INTO projection_thread_messages_trigram(rowid, text)
      VALUES (new.rowid, new.text);
    END
  `;
});
