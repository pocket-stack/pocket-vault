// host/index.ts — the vault on disk becomes a SQLite database on the Mac:
// one row per note, an FTS5 index over titles and bodies, and a version
// that bumps when the folder changes. The 3DS never reads a file; it asks
// this index for a page of titles or a search, and the answer is a few
// hundred bytes.
//
// The database lives beside the vault (`<vault>/.pocket-vault/index.sqlite`)
// so a second start only re-reads notes whose size or mtime moved. A watcher
// on the folder re-syncs after a quiet 300 ms and hands the new version to
// whoever wants to publish it.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { ListItem } from "../app/protocol.ts";

const INDEX_DIR = ".pocket-vault";

export interface IndexedNote {
  id: number;
  path: string;
  title: string;
  size: number;
  mtime: number;
}

export class VaultIndex {
  readonly dir: string;
  private readonly db: Database;
  private version = 1;
  private watcher: FSWatcher | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(version: number) => void>();

  constructor(dir: string, options: { memory?: boolean } = {}) {
    this.dir = resolve(dir);
    if (!existsSync(this.dir)) throw new Error(`pocket-vault: no such vault: ${this.dir}`);
    let file = ":memory:";
    if (!options.memory) {
      mkdirSync(join(this.dir, INDEX_DIR), { recursive: true });
      file = join(this.dir, INDEX_DIR, "index.sqlite");
    }
    this.db = new Database(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, tokenize = 'porter unicode61');
    `);
  }

  /** Bring the database in line with the folder. Returns how many notes
   *  were (re)read. */
  sync(): number {
    const seen = new Set<string>();
    const files = walk(this.dir);
    const known = new Map<string, IndexedNote>();
    for (const row of this.db.query<IndexedNote, []>("SELECT id, path, title, size, mtime FROM notes").all()) {
      known.set(row.path, row);
    }
    const upsert = this.db.query<{ id: number }, [string, string, number, number]>(
      "INSERT INTO notes (path, title, size, mtime) VALUES (?1, ?2, ?3, ?4) " +
        "ON CONFLICT(path) DO UPDATE SET title = ?2, size = ?3, mtime = ?4 RETURNING id",
    );
    const dropFts = this.db.query("DELETE FROM notes_fts WHERE rowid = ?1");
    const addFts = this.db.query("INSERT INTO notes_fts (rowid, title, body) VALUES (?1, ?2, ?3)");
    let changed = 0;
    const run = this.db.transaction(() => {
      for (const path of files) {
        const rel = relative(this.dir, path);
        seen.add(rel);
        const stat = statSync(path);
        const mtime = Math.floor(stat.mtimeMs);
        const before = known.get(rel);
        if (before && before.size === stat.size && before.mtime === mtime) continue;
        const body = readFileSync(path, "utf8");
        const title = titleOf(body, rel);
        const { id } = upsert.get(rel, title, stat.size, mtime)!;
        dropFts.run(id);
        addFts.run(id, title, body);
        changed += 1;
      }
      for (const [rel, row] of known) {
        if (seen.has(rel)) continue;
        this.db.query("DELETE FROM notes WHERE id = ?1").run(row.id);
        dropFts.run(row.id);
        changed += 1;
      }
    });
    run();
    if (changed > 0) this.version += 1;
    return changed;
  }

  count(): number {
    return this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM notes").get()!.n;
  }

  currentVersion(): number {
    return this.version;
  }

  /** A page of notes, by title, or by relevance when `q` is given. */
  list(q: string | undefined, offset: number, limit: number): { total: number; items: ListItem[] } {
    limit = Math.max(1, Math.min(64, limit));
    offset = Math.max(0, offset);
    const query = q?.trim() ?? "";
    if (query === "") {
      const total = this.count();
      const items = this.db
        .query<ListItem, [number, number]>("SELECT id, title, size FROM notes ORDER BY title COLLATE NOCASE LIMIT ?1 OFFSET ?2")
        .all(limit, offset);
      return { total, items };
    }
    const match = ftsQuery(query);
    const total = this.db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?1")
      .get(match)!.n;
    const items = this.db
      .query<ListItem, [string, number, number]>(
        "SELECT n.id, n.title, n.size FROM notes_fts f JOIN notes n ON n.id = f.rowid " +
          "WHERE notes_fts MATCH ?1 ORDER BY rank LIMIT ?2 OFFSET ?3",
      )
      .all(match, limit, offset);
    return { total, items };
  }

  note(id: number): IndexedNote | null {
    return this.db.query<IndexedNote, [number]>("SELECT id, path, title, size, mtime FROM notes WHERE id = ?1").get(id);
  }

  absolute(note: IndexedNote): string {
    return join(this.dir, note.path);
  }

  /** Called after this process writes a note, so the next sync does not
   *  read it back as a foreign change. */
  touch(id: number, body: string): void {
    const note = this.note(id);
    if (!note) return;
    const stat = statSync(this.absolute(note));
    const title = titleOf(body, note.path);
    this.db
      .query("UPDATE notes SET title = ?2, size = ?3, mtime = ?4 WHERE id = ?1")
      .run(id, title, stat.size, Math.floor(stat.mtimeMs));
    this.db.query("DELETE FROM notes_fts WHERE rowid = ?1").run(id);
    this.db.query("INSERT INTO notes_fts (rowid, title, body) VALUES (?1, ?2, ?3)").run(id, title, body);
  }

  onChange(listener: (version: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Watch the folder; a quiet 300 ms after the last event re-syncs. */
  watch(): void {
    if (this.watcher) return;
    this.watcher = watch(this.dir, { recursive: true }, (_event, name) => {
      if (typeof name === "string" && name.startsWith(INDEX_DIR)) return;
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => {
        this.syncTimer = null;
        const before = this.version;
        try {
          this.sync();
        } catch (error) {
          console.error(`pocket-vault: sync failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (this.version !== before) for (const listener of this.listeners) listener(this.version);
      }, 300);
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.db.close();
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
}

/** Front matter `title:`, else the first H1, else the file name. */
export function titleOf(body: string, path: string): string {
  const head = body.slice(0, 4096).split("\n");
  if (head[0] === "---") {
    for (let i = 1; i < head.length && head[i] !== "---"; i++) {
      const m = /^title:\s*(.+)$/.exec(head[i]!);
      if (m) return m[1]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  for (const line of head) {
    const m = /^#\s+(.+)$/.exec(line);
    if (m) return m[1]!.trim();
  }
  return basename(path, ".md");
}

/** A user's words → an FTS5 query: every term quoted, prefix-matched. */
export function ftsQuery(text: string): string {
  const terms = text
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, ""))
    .filter((term) => term !== "");
  if (terms.length === 0) return '""';
  return terms.map((term) => `"${term}"*`).join(" ");
}
