import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { Tooltip } from "./Tooltip";
import { useTheme, type ThemePref } from "./theme";
import { toast } from "./toast";
import {
  createFile,
  deleteFile,
  duplicateFile,
  listFiles,
  previewFromDoc,
  readDoc,
  readDocSync,
  relTime,
  renameFile,
  restoreFile,
  trashFile,
  patchFile,
  docFromImport,
  TEMPLATES,
  type FileMeta,
  type TemplateId,
} from "../engine/files";
import { importSvg } from "../engine/svgImport";
import { importSketch } from "../engine/sketchImport";
import { importFig } from "../engine/figImport";

/**
 * The file browser the product opens with — Recents, Drafts, Trash — instead of
 * dropping straight into an unnamed editor tab. Same job Figma's dashboard does:
 * pick up where you left off, or start something new.
 *
 * Everything here is local: files live in the browser's own storage through
 * `engine/files`, so opening a file is synchronous when the document fits in
 * localStorage and falls back to an async IndexedDB read when it does not.
 */

type View = "recents" | "files" | "trash";
type Sort = "recent" | "name" | "created";
type Filter = "all" | "design" | "prototype";

const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "recents", label: "Recents", icon: "refresh" },
  { id: "files", label: "All files", icon: "layers" },
  { id: "trash", label: "Trash", icon: "trash" },
];

export function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [view, setView] = useState<View>("recents");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [filter, setFilter] = useState<Filter>("all");
  const [layout, setLayout] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem("x-native-dash-layout") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [rows, setRows] = useState<FileMeta[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [acctMenu, setAcctMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState("");
  const [dropOn, setDropOn] = useState(false);
  const search = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const { pref, setPref } = useTheme();

  const refresh = () => setRows(listFiles(view === "trash"));

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    const onStorage = () => refresh();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [view]);

  useEffect(() => {
    try {
      localStorage.setItem("x-native-dash-layout", layout);
    } catch {
      /* preference only */
    }
  }, [layout]);

  const projects = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of rows) if (f.project) m.set(f.project, (m.get(f.project) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows.filter((f) => (q ? f.name.toLowerCase().includes(q) : true));
    if (filter === "design") list = list.filter((f) => !f.prototyped);
    if (filter === "prototype") list = list.filter((f) => f.prototyped);
    if (sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "created") list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    else list = [...list].sort((a, b) => Math.max(b.openedAt, b.editedAt) - Math.max(a.openedAt, a.editedAt));
    return list;
  }, [rows, query, sort, filter]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, shown.length - 1)));
  }, [shown.length]);

  const open = (id: string) => {
    const doc = readDocSync(id);
    if (doc) {
      onOpen(id);
      return;
    }
    // The document overflowed localStorage into IndexedDB: read it for real,
    // no invented progress.
    setBusy("Loading…");
    readDoc(id)
      .then((doc2) => {
        setBusy("");
        if (!doc2) {
          toast("This file's contents could not be read — it may be from another browser");
          return;
        }
        onOpen(id);
      })
      .catch(() => {
        setBusy("");
        toast("Could not open this file");
      });
  };

  const startNew = (template: TemplateId) => {
    const meta = createFile({ template });
    setNewMenu(false);
    refresh();
    onOpen(meta.id);
  };

  const commitRename = (id: string) => {
    const name = draft.trim();
    if (name) renameFile(id, name);
    setRenaming(null);
    refresh();
  };

  const removeForGood = (id: string) => {
    deleteFile(id);
    setMenu(null);
    refresh();
    toast("File deleted");
  };

  const moveToFile = (id: string, project: string) => {
    patchFile(id, { project: project || undefined });
    setMenu(null);
    refresh();
    toast(project ? `Moved to ${project}` : "Moved to Drafts");
  };

  const exportMeta = (f: FileMeta) => {
    const doc = readDocSync(f.id);
    setMenu(null);
    if (!doc) {
      toast("Nothing stored locally to export");
      return;
    }
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${f.name || "Untitled"}.x.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  /* importing: drop a .fig / .sketch / .svg anywhere on the dashboard */
  const importFiles = async (files: File[]) => {
    for (const f of files) {
      setBusy(`Importing ${f.name}…`);
      try {
        let result;
        if (/\.svg$/i.test(f.name) || f.type === "image/svg+xml") {
          result = await importSvg(await f.text());
        } else if (/\.sketch$/i.test(f.name)) {
          result = await importSketch(await f.arrayBuffer());
        } else if (/\.fig$/i.test(f.name)) {
          result = await importFig(await f.arrayBuffer());
        } else {
          setBusy("");
          toast(`${f.name} is not a .fig, .sketch or .svg file`);
          continue;
        }
        const name = f.name.replace(/\.[a-z0-9]+$/i, "");
        const meta = createFile({
          name,
          template: "blank",
          doc: docFromImport(name, result),
        });
        setBusy("");
        refresh();
        if (result.nodes.length) {
          onOpen(meta.id);
          return;
        }
        toast(`No importable layers found in ${f.name}`);
      } catch (err) {
        setBusy("");
        toast(`Could not read ${f.name}: ${err instanceof Error ? err.message : "unreadable"}`);
      }
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (!typing && e.key === "/") {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        startNew("blank");
        return;
      }
      if (typing) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setCursor((c) => Math.min(shown.length - 1, c + 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter" && shown[cursor]) {
        e.preventDefault();
        open(shown[cursor].id);
      } else if ((e.key === "Backspace" || e.key === "Delete") && shown[cursor]) {
        e.preventDefault();
        if (view === "trash") removeForGood(shown[cursor].id);
        else {
          trashFile(shown[cursor].id);
          refresh();
          toast("Moved to trash");
        }
      } else if (e.key === "F2" && shown[cursor]) {
        e.preventDefault();
        setRenaming(shown[cursor].id);
        setDraft(shown[cursor].name);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, cursor, view]);

  useEffect(() => {
    if (!menu) return;
    const off = () => setMenu(null);
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [menu]);

  const title = view === "recents" ? "Recently viewed" : view === "trash" ? "Trash" : "All files";

  return (
    <div
      className="dash"
      onDragOver={(e) => {
        e.preventDefault();
        setDropOn(true);
      }}
      onDragLeave={() => setDropOn(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropOn(false);
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) void importFiles(files);
      }}
    >
      <header className="dash-top">
        <div className="dash-top-l">
          <div className="logo-btn" onMouseDown={(e) => e.stopPropagation()}>
            <button className="icon-btn" title="Account & settings" onClick={() => setAcctMenu((v) => !v)}>
              <Icon name="logo" size={20} />
            </button>
            {acctMenu && (
              <div className="dash-menu" onMouseLeave={() => setAcctMenu(false)}>
                <div className="dm-head">
                  <span className="dm-avatar">X</span>
                  <div>
                    <div className="dm-name">You</div>
                    <div className="dm-sub">Local workspace · offline</div>
                  </div>
                </div>
                <hr />
                <div className="dm-label">Theme</div>
                <div className="dm-themes">
                  {(["light", "dark", "graphite", "daylight", "system"] as ThemePref[]).map((t) => (
                    <button
                      key={t}
                      className={pref === t ? "on" : ""}
                      onClick={() => setPref(t)}
                    >
                      {t === "daylight" ? "Day" : t === "graphite" ? "Graphite" : t === "system" ? "System" : t[0].toUpperCase() + t.slice(1)}
                      {pref === t && <Icon name="check" size={12} />}
                    </button>
                  ))}
                </div>
                <hr />
                <button onClick={() => { setAcctMenu(false); fileInput.current?.click(); }}>
                  Import file… <span className="sc">.fig .sketch .svg</span>
                </button>
                <button
                  onClick={() => {
                    setAcctMenu(false);
                    window.dispatchEvent(new CustomEvent("x-native-shortcuts"));
                  }}
                >
                  Keyboard shortcuts <span className="sc">?</span>
                </button>
              </div>
            )}
          </div>
          <span className="dash-title">X-Native</span>
          <span className="dash-crumb">/ Drafts</span>
        </div>
        <div className="dash-search">
          <Icon name="search" size={14} />
          <input
            ref={search}
            placeholder="Search files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search files"
          />
          {query ? (
            <button className="mini" title="Clear" onClick={() => setQuery("")}>
              <Icon name="close" size={12} />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </div>
        <div className="dash-top-r">
          {busy && <span className="dash-busy">{busy}</span>}
          <Tooltip label="Help" shortcut="?">
            <button
              className="icon-btn"
              onClick={() => window.dispatchEvent(new CustomEvent("x-native-shortcuts"))}
            >
              <Icon name="help" size={16} />
            </button>
          </Tooltip>
          <div className="logo-btn" onMouseDown={(e) => e.stopPropagation()}>
            <div className="new-split">
              <button className="primary" onClick={() => startNew("blank")}>
                <Icon name="plus" size={14} />
                New design file
              </button>
              <button
                className="primary caret-btn"
                aria-label="New file from template"
                onClick={() => setNewMenu((v) => !v)}
              >
                <Icon name="chevron-down" size={12} />
              </button>
            </div>
            {newMenu && (
              <div className="dash-menu wide" onMouseLeave={() => setNewMenu(false)}>
                <div className="dm-label">New file</div>
                {TEMPLATES.map((t) => (
                  <button key={t.id} onClick={() => startNew(t.id)}>
                    <Icon name={TEMPLATE_ICON[t.id]} size={14} />
                    {t.label}
                    <span className="sc">{t.hint}</span>
                  </button>
                ))}
                <hr />
                <button onClick={() => { setNewMenu(false); fileInput.current?.click(); }}>
                  <Icon name="import" size={14} /> Import from file…
                </button>
              </div>
            )}
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".fig,.sketch,.svg,.json"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            if (files.length) void importFiles(files);
          }}
        />
      </header>

      <div className="dash-body">
        <aside className="dash-side">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`side-item${view === v.id ? " on" : ""}`}
              onClick={() => setView(v.id)}
            >
              <Icon name={v.icon} size={14} />
              {v.label}
            </button>
          ))}
          <div className="side-sep" />
          <div className="side-label">
            Projects
            <Tooltip label="New project" placement="left">
              <button
                className="mini"
                onClick={() => {
                  const name = window.prompt("Project name");
                  if (name?.trim()) toast(`Project "${name.trim()}" — move files into it from their ⋯ menu`);
                }}
              >
                <Icon name="plus" size={12} />
              </button>
            </Tooltip>
          </div>
          <div className="side-items">
            {projects.length === 0 && <p className="side-empty">No projects yet. Use a file card’s More menu to group files.</p>}
            {projects.map(([name, count]) => (
              <button
                key={name}
                className={`side-item${query === name ? " on" : ""}`}
                onClick={() => {
                  setView("files");
                  setQuery(name);
                }}
              >
                <Icon name="folder" size={14} />
                {name}
                <span className="count">{count}</span>
              </button>
            ))}
          </div>
          <div className="side-foot">
            <span className="dot-live" />
            Stored in this browser · {rows.length} file{rows.length === 1 ? "" : "s"}
          </div>
        </aside>

        <main className="dash-main">
          <div className="dash-head">
            <h1>{title}</h1>
            <div className="dash-head-r">
              <div className="seg pills">
                {(["all", "design", "prototype"] as Filter[]).map((f) => (
                  <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                    {f === "all" ? "All" : f === "design" ? "Design" : "Prototypes"}
                  </button>
                ))}
              </div>
              <div className="sort">
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort files">
                  <option value="recent">Last viewed</option>
                  <option value="name">Name</option>
                  <option value="created">Created</option>
                </select>
              </div>
              <div className="seg icons view">
                <button
                  className={layout === "grid" ? "on" : ""}
                  title="Grid view"
                  onClick={() => setLayout("grid")}
                >
                  <Icon name="grid-view" size={14} />
                </button>
                <button
                  className={layout === "list" ? "on" : ""}
                  title="List view"
                  onClick={() => setLayout("list")}
                >
                  <Icon name="list-view" size={14} />
                </button>
              </div>
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="dash-empty">
              <div className="dash-empty-art">
                <Icon name={view === "trash" ? "trash" : "frame"} size={28} />
              </div>
              <p className="dash-empty-title">
                {view === "trash"
                  ? "Trash is empty"
                  : query
                    ? `No files match “${query}”`
                    : "No files yet"}
              </p>
              <p className="dash-empty-body">
                {view === "trash"
                  ? "Deleted files rest here until you remove them for good."
                  : query
                    ? "Try a different name, or start something new."
                    : "Start a design file, or drop a .fig, .sketch or .svg anywhere on this page to import it."}
              </p>
              {view !== "trash" && !query && (
                <button className="primary" onClick={() => startNew("blank")}>
                  <Icon name="plus" size={14} /> New design file
                </button>
              )}
            </div>
          ) : layout === "grid" ? (
            <div className="file-grid">
              {shown.map((f, i) => (
                <div
                  key={f.id}
                  className={`file-card${cursor === i ? " cur" : ""}`}
                  onClick={() => (view === "trash" ? undefined : open(f.id))}
                  onDoubleClick={() => view !== "trash" && open(f.id)}
                  tabIndex={0}
                  onFocus={() => setCursor(i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") view === "trash" ? undefined : open(f.id);
                    if (e.key === "Delete" || e.key === "Backspace") {
                      e.preventDefault();
                      if (view === "trash") removeForGood(f.id);
                      else {
                        trashFile(f.id);
                        refresh();
                        toast("Moved to trash");
                      }
                    }
                  }}
                >
                  <div className="thumb">
                    {f.thumb ? (
                      <img src={f.thumb} alt="" />
                    ) : (
                      <div className="thumb-empty">
                        <Icon name={TEMPLATE_ICON[f.template] ?? "frame"} size={22} />
                      </div>
                    )}
                    {view !== "trash" && (
                      <div className="thumb-hover">
                        <span className="open-chip">Open</span>
                        {f.prototyped && (
                          <Tooltip label="Play prototype">
                            <button
                              className="play-chip"
                              onClick={(e) => {
                                e.stopPropagation();
                                open(f.id);
                              }}
                            >
                              <Icon name="play" size={12} />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="file-meta">
                    {renaming === f.id ? (
                      <input
                        className="rename"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => commitRename(f.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(f.id);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      <span className="file-name" title={f.name}>
                        {f.name}
                      </span>
                    )}
                    <span className="file-sub">
                      Draft · {relTime(view === "recents" ? Math.max(f.openedAt, f.editedAt) : f.editedAt)}
                      {f.project ? ` · ${f.project}` : ""}
                    </span>
                    <div className="logo-btn card-more" onMouseDown={(e) => e.stopPropagation()}>
                      <button
                        className="mini"
                        title="More"
                        aria-label={`More actions for ${f.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenu(menu === f.id ? null : f.id);
                        }}
                      >
                        <Icon name="more" size={14} />
                      </button>
                      {menu === f.id && (
                        <div className="dash-menu" onClick={(e) => e.stopPropagation()}>
                          {view === "trash" ? (
                            <>
                              <button onClick={() => { restoreFile(f.id); setMenu(null); refresh(); }}>
                                <Icon name="refresh" size={14} /> Restore
                              </button>
                              <button className="danger" onClick={() => removeForGood(f.id)}>
                                <Icon name="trash" size={14} /> Delete forever
                              </button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => { open(f.id); setMenu(null); }}>
                                <Icon name="open" size={14} /> Open
                              </button>
                              <button
                                onClick={() => {
                                  setMenu(null);
                                  setRenaming(f.id);
                                  setDraft(f.name);
                                }}
                              >
                                <Icon name="edit-text" size={14} /> Rename
                              </button>
                              <button onClick={() => { duplicateFile(f.id); setMenu(null); refresh(); }}>
                                <Icon name="duplicate" size={14} /> Duplicate
                              </button>
                              <button onClick={() => exportMeta(f)}>
                                <Icon name="export" size={14} /> Export a copy
                              </button>
                              <hr />
                              <div className="dm-label">Move to project</div>
                              <button onClick={() => moveToFile(f.id, "")}>Drafts</button>
                              {projects.map(([name]) => (
                                <button key={name} onClick={() => moveToFile(f.id, name)}>
                                  {name}
                                </button>
                              ))}
                              <hr />
                              <button className="danger" onClick={() => { trashFile(f.id); setMenu(null); refresh(); toast("Moved to trash"); }}>
                                <Icon name="trash" size={14} /> Move to trash
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="file-list">
              <div className="fl-head">
                <span>Name</span>
                <span>Project</span>
                <span>Edited</span>
                <span>Layers</span>
                <span />
              </div>
              {shown.map((f, i) => (
                <div
                  key={f.id}
                  className={`fl-row${cursor === i ? " cur" : ""}`}
                  tabIndex={0}
                  onFocus={() => setCursor(i)}
                  onClick={() => view !== "trash" && open(f.id)}
                >
                  <span className="fl-name">
                    <span className="fl-thumb">
                      {f.thumb ? <img src={f.thumb} alt="" /> : <Icon name={TEMPLATE_ICON[f.template] ?? "frame"} size={14} />}
                    </span>
                    {renaming === f.id ? (
                      <input
                        className="rename"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitRename(f.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(f.id);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      f.name
                    )}
                    {f.prototyped && <span className="chip proto">Prototype</span>}
                  </span>
                  <span className="fl-dim">{f.project ?? "Drafts"}</span>
                  <span className="fl-dim">{relTime(f.editedAt)}</span>
                  <span className="fl-dim">{f.nodes}</span>
                  <span className="fl-act">
                    {view === "trash" ? (
                      <>
                        <button className="mini" title="Restore" onClick={(e) => { e.stopPropagation(); restoreFile(f.id); refresh(); }}>
                          <Icon name="refresh" size={14} />
                        </button>
                        <button className="mini" title="Delete forever" onClick={(e) => { e.stopPropagation(); removeForGood(f.id); }}>
                          <Icon name="trash" size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="mini" title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(f.id); setDraft(f.name); }}>
                          <Icon name="edit-text" size={14} />
                        </button>
                        <button className="mini" title="Duplicate" onClick={(e) => { e.stopPropagation(); duplicateFile(f.id); refresh(); }}>
                          <Icon name="duplicate" size={14} />
                        </button>
                        <button className="mini" title="Move to trash" onClick={(e) => { e.stopPropagation(); trashFile(f.id); refresh(); toast("Moved to trash"); }}>
                          <Icon name="trash" size={14} />
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="dash-hint">
            <span><kbd>/</kbd> search</span>
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>⌫</kbd> trash</span>
            <span><kbd>⌘N</kbd> new file</span>
          </div>
        </main>
      </div>

      {dropOn && (
        <div className="dropveil">
          <div className="dropcard">
            <Icon name="import" size={22} />
            Drop .fig, .sketch or .svg to import
          </div>
        </div>
      )}
    </div>
  );
}

const TEMPLATE_ICON: Record<string, string> = {
  blank: "frame",
  mobile: "phone",
  desktop: "desktop",
  presentation: "slide",
  wireframe: "grid",
  prototype: "proto",
};

/** Regenerate a file's preview from its stored document. The editor calls this
 *  after a save so the card reflects the work without reopening the file. */
export function refreshThumb(id: string, doc: Parameters<typeof previewFromDoc>[0]): void {
  const thumb = previewFromDoc(doc);
  if (thumb) patchFile(id, { thumb, editedAt: Date.now() });
}
