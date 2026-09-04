// host/index.ts — the vault on disk becomes a SQLite database on the Mac:
// one row per note, an FTS5 index over titles and bodies, a table of tags and
// one of wiki links, and a version that bumps when the folder changes. The
// 3DS never reads a file; it asks this index for a folder's children, a page
// of notes, a tag list or a note's backlinks, and the answer is a few hundred
// bytes.
//
// Indexing must not measure text: extraction runs over classify()'s per-line
// kinds (O(lines), no fonts), so a thousand 110 KB notes index in about a
// second and a half. Wrapping happens only for a note the console opens.
//
// The database lives beside the vault (`<vault>/.pocket-vault/index.sqlite`)
// so a second start only re-reads notes whose size or mtime moved. A watcher
// on the folder re-syncs after a quiet 300 ms and hands the new version to
// whoever wants to publish it.

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { classify } from "../app/markdown.ts";
import type { ListItem, TagItem, TreeEntry } from "../app/protocol.ts";
import { linksOf, snippetOf, tagsOf, titleOf } from "./layout.ts";

/** Bump when the tables below change shape. */
const SCHEMA_VERSION = 2;
const INDEX_DIR = ".pocket-vault";
const TRASH_DIR = ".trash";

export interface IndexedNote {
  id: number;
  path: string;
  title: string;
  snippet: string;
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
    // The schema is versioned because `CREATE TABLE IF NOT EXISTS` does not
    // migrate: an index written by an older build keeps its old columns and
    // every query against a new one fails. Re-reading the vault costs a
    // second or two, so a version bump simply rebuilds.
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version !== SCHEMA_VERSION) {
      for (const table of ["notes_fts", "links", "tags", "notes"]) {
        this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        folder TEXT NOT NULL,
        title TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_folder ON notes (folder);
      CREATE TABLE IF NOT EXISTS tags (
        note_id INTEGER NOT NULL,
        tag TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tags_tag ON tags (tag);
      CREATE INDEX IF NOT EXISTS tags_note ON tags (note_id);
      CREATE TABLE IF NOT EXISTS links (
        note_id INTEGER NOT NULL,
        target TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS links_target ON links (target);
      CREATE INDEX IF NOT EXISTS links_note ON links (note_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, tokenize = 'porter unicode61');
    `);
  }

  /** Bring the database in line with the folder. Returns how many notes
   *  were (re)read. `db.query` caches its prepared statement by SQL, so the
   *  literals below prepare once for the whole run. */
  sync(): number {
    const seen = new Set<string>();
    const files = walk(this.dir);
    const known = new Map<string, IndexedNote>();
    for (const row of this.db
      .query<IndexedNote, []>("SELECT id, path, title, snippet, size, mtime FROM notes")
      .all()) {
      known.set(row.path, row);
    }
    let changed = 0;
    const run = this.db.transaction(() => {
      for (const path of files) {
        const rel = relative(this.dir, path);
        seen.add(rel);
        const stat = statSync(path);
        const mtime = Math.floor(stat.mtimeMs);
        const before = known.get(rel);
        if (before && before.size === stat.size && before.mtime === mtime) continue;
        this.record(rel, readFileSync(path, "utf8"), stat.size, mtime);
        changed += 1;
      }
      for (const [rel, row] of known) {
        if (seen.has(rel)) continue;
        this.forget(row.id);
        changed += 1;
      }
    });
    run();
    if (changed > 0) this.version += 1;
    return changed;
  }

  /** Write one note's row, its search text, its tags and its links. */
  private record(rel: string, body: string, size: number, mtime: number): number {
    const lines = body.split("\n");
    const kinds = classify(lines);
    const title = titleOf(lines, kinds, basename(rel, ".md"));
    const folder = dirname(rel) === "." ? "" : dirname(rel);
    const { id } = this.db
      .query<{ id: number }, [string, string, string, string, number, number]>(
        "INSERT INTO notes (path, folder, title, snippet, size, mtime) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
          "ON CONFLICT(path) DO UPDATE SET folder = ?2, title = ?3, snippet = ?4, size = ?5, mtime = ?6 RETURNING id",
      )
      .get(rel, folder, title, snippetOf(lines, kinds), size, mtime)!;
    this.db.query("DELETE FROM notes_fts WHERE rowid = ?1").run(id);
    this.db.query("INSERT INTO notes_fts (rowid, title, body) VALUES (?1, ?2, ?3)").run(id, title, body);
    this.db.query("DELETE FROM tags WHERE note_id = ?1").run(id);
    const addTag = this.db.query("INSERT INTO tags (note_id, tag) VALUES (?1, ?2)");
    for (const tag of tagsOf(lines, kinds)) addTag.run(id, tag);
    this.db.query("DELETE FROM links WHERE note_id = ?1").run(id);
    const addLink = this.db.query("INSERT INTO links (note_id, target) VALUES (?1, ?2)");
    for (const link of linksOf(lines, kinds)) addLink.run(id, link.target.toLowerCase());
    return id;
  }

  private forget(id: number): void {
    this.db.query("DELETE FROM notes WHERE id = ?1").run(id);
    this.db.query("DELETE FROM notes_fts WHERE rowid = ?1").run(id);
    this.db.query("DELETE FROM tags WHERE note_id = ?1").run(id);
    this.db.query("DELETE FROM links WHERE note_id = ?1").run(id);
  }

  /** Re-read one note from disk into the index. */
  private reindex(rel: string, body: string): number {
    const stat = statSync(join(this.dir, rel));
    return this.record(rel, body, stat.size, Math.floor(stat.mtimeMs));
  }

  count(): number {
    return this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM notes").get()!.n;
  }

  currentVersion(): number {
    return this.version;
  }

  /** One folder's children: subfolders with their note counts, then notes,
   *  cut to `limit` — the reply has to fit one companion line, and a folder
   *  with hundreds of notes is browsed in the note list. */
  tree(folder: string, limit = 48): { entries: TreeEntry[]; total: number } {
    const prefix = folder === "" ? "" : `${folder}/`;
    const dirs = new Map<string, number>();
    for (const row of this.db
      .query<{ folder: string; n: number }, [string]>(
        "SELECT folder, count(*) AS n FROM notes WHERE folder = ?1 OR folder LIKE ?1 || '%' GROUP BY folder",
      )
      .all(prefix)) {
      if (row.folder === folder) continue;
      const rest = row.folder.slice(prefix.length);
      const head = rest.split("/")[0]!;
      if (head === "") continue;
      dirs.set(head, (dirs.get(head) ?? 0) + row.n);
    }
    const entries: TreeEntry[] = [...dirs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ path: prefix + name, name, folder: true, count }));
    for (const row of this.db
      .query<{ id: number; path: string; title: string }, [string]>(
        "SELECT id, path, title FROM notes WHERE folder = ?1 ORDER BY title COLLATE NOCASE",
      )
      .all(folder)) {
      entries.push({ path: row.path, name: row.title, folder: false, id: row.id });
    }
    return { entries: entries.slice(0, Math.max(1, limit)), total: entries.length };
  }

  /** A page of notes: by title, by folder, by tag, or by search relevance. */
  list(
    options: { q?: string; folder?: string; tag?: string },
    offset: number,
    limit: number,
  ): { total: number; items: ListItem[] } {
    limit = Math.max(1, Math.min(64, limit));
    offset = Math.max(0, offset);
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (options.folder !== undefined && options.folder !== "") {
      where.push("(n.folder = ? OR n.folder LIKE ? || '/%')");
      args.push(options.folder, options.folder);
    }
    if (options.tag !== undefined && options.tag !== "") {
      where.push("n.id IN (SELECT note_id FROM tags WHERE tag = ?)");
      args.push(options.tag);
    }
    const query = options.q?.trim() ?? "";
    const columns = "n.id, n.title, n.snippet, n.size, n.mtime";
    if (query === "") {
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const total = this.db
        .query<{ n: number }, Array<string | number>>(`SELECT count(*) AS n FROM notes n ${clause}`)
        .get(...args)!.n;
      const items = this.db
        .query<ListItem, Array<string | number>>(
          `SELECT ${columns} FROM notes n ${clause} ORDER BY n.title COLLATE NOCASE LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset);
      return { total, items };
    }
    const match = ftsQuery(query);
    const clause = ["notes_fts MATCH ?", ...where].join(" AND ");
    const total = this.db
      .query<{ n: number }, Array<string | number>>(
        `SELECT count(*) AS n FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE ${clause}`,
      )
      .get(match, ...args)!.n;
    const items = this.db
      .query<ListItem, Array<string | number>>(
        `SELECT ${columns} FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE ${clause} ORDER BY rank LIMIT ? OFFSET ?`,
      )
      .all(match, ...args, limit, offset);
    return { total, items };
  }

  tags(): TagItem[] {
    return this.db
      .query<TagItem, []>("SELECT tag, count(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag")
      .all();
  }

  /** Notes whose wiki links point at this note's title or file name. */
  backlinks(id: number): Array<{ id: number; title: string }> {
    const note = this.note(id);
    if (!note) return [];
    const names = [note.title.toLowerCase(), basename(note.path, ".md").toLowerCase()];
    return this.db
      .query<{ id: number; title: string }, [string, string]>(
        "SELECT DISTINCT n.id, n.title FROM links l JOIN notes n ON n.id = l.note_id " +
          "WHERE (l.target = ?1 OR l.target = ?2) AND n.id != (SELECT id FROM notes WHERE title = ?1 LIMIT 1) " +
          "ORDER BY n.title COLLATE NOCASE",
      )
      .all(names[0]!, names[1]!)
      .filter((row) => row.id !== id);
  }

  /** The note a wiki link names, by title then by file name. */
  resolve(target: string): number | null {
    const row = this.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM notes WHERE lower(title) = ?1 OR lower(path) = ?1 || '.md' " +
          "OR lower(path) LIKE '%/' || ?1 || '.md' LIMIT 1",
      )
      .get(target.toLowerCase());
    return row?.id ?? null;
  }

  note(id: number): IndexedNote | null {
    return this.db
      .query<IndexedNote, [number]>("SELECT id, path, title, snippet, size, mtime FROM notes WHERE id = ?1")
      .get(id);
  }

  absolute(note: IndexedNote): string {
    return join(this.dir, note.path);
  }

  /** Called after this process writes a note, so the next sync does not read
   *  it back as a foreign change. */
  touch(id: number, body: string): void {
    const note = this.note(id);
    if (!note) return;
    this.reindex(note.path, body);
  }

  /** Create a note. Returns its id and vault-relative path. */
  create(folder: string, title: string, body?: string): { id: number; path: string } {
    const safeFolder = safePath(folder);
    const name = fileNameFor(title);
    mkdirSync(join(this.dir, safeFolder), { recursive: true });
    let rel = safeFolder === "" ? `${name}.md` : `${safeFolder}/${name}.md`;
    let n = 2;
    while (existsSync(join(this.dir, rel))) {
      rel = safeFolder === "" ? `${name}-${n}.md` : `${safeFolder}/${name}-${n}.md`;
      n += 1;
    }
    const text = body ?? `# ${title}\n\n`;
    writeFileSync(join(this.dir, rel), text);
    const id = this.reindex(rel, text);
    this.version += 1;
    return { id, path: rel };
  }

  mkdir(folder: string, name: string): { path: string } {
    const rel = safePath(folder === "" ? name : `${folder}/${name}`);
    mkdirSync(join(this.dir, rel), { recursive: true });
    this.version += 1;
    return { path: rel };
  }

  /** Move a note into the vault's `.trash` — a delete the user can undo in
   *  Finder, which is what an editor owes a folder it does not own. */
  remove(id: number): boolean {
    const note = this.note(id);
    if (!note) return false;
    const trash = join(this.dir, TRASH_DIR);
    mkdirSync(trash, { recursive: true });
    let target = join(trash, basename(note.path));
    let n = 2;
    while (existsSync(target)) {
      target = join(trash, `${basename(note.path, ".md")}-${n}.md`);
      n += 1;
    }
    renameSync(this.absolute(note), target);
    this.forget(id);
    this.version += 1;
    return true;
  }

  onChange(listener: (version: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Watch the folder; a quiet 300 ms after the last event re-syncs. */
  watch(): void {
    if (this.watcher) return;
    this.watcher = watch(this.dir, { recursive: true }, (_event, name) => {
      if (typeof name === "string" && (name.startsWith(INDEX_DIR) || name.startsWith(TRASH_DIR))) return;
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
  return out;
}

/** A vault-relative path with no way out of the vault. */
export function safePath(path: string): string {
  return path
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .map((part) => part.replace(/[/\\:*?"<>|]/g, "-"))
    .join("/");
}

export function fileNameFor(title: string): string {
  const clean = title.trim().replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ");
  return clean === "" ? "Untitled" : clean.slice(0, 80);
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
