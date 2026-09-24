import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { MemoryEngine } from "./engine/memory";
import { Canvas } from "./ui/Canvas";
import { copyText } from "./engine/clipboard";
import { worldPos } from "./engine/memory";
import { zoomTo } from "./ui/zoom";
import {
  Actions,
  HelpBtn,
  LeftPanel,
  NavRail,
  Toolbar,
  bindHotkeys,
  usePanelDrag,
  type NavId,
} from "./ui/chrome";
import { Icon } from "./ui/icons";
import { RightPanel, copyPng } from "./ui/inspector";
import { FigInspectorModal } from "./ui/FigInspectorModal";
import { PresentationPlayer } from "./ui/PresentationPlayer";
import { subscribeToast, toast as toastMsg } from "./ui/toast";
import { saveDoc } from "./engine/persist";
import { Dashboard } from "./ui/Dashboard";
import { ensureDemoFile, getFile, migrateLegacyDoc, readDoc, readDocSync, saveFile, type DocSeed } from "./engine/files";

/** The dashboard is the app's front door; a file opens at `#/file/<id>`. The
 *  hash is the source of truth so reload, back and a shared link all behave. */
function readRoute(): { view: "home" } | { view: "file"; id: string } {
  const m = /#\/file\/([^/?#]+)/.exec(window.location.hash || "");
  return m ? { view: "file", id: decodeURIComponent(m[1]) } : { view: "home" };
}

export default function App() {
  const [route, setRoute] = useState(readRoute);
  // The document is resolved before the editor mounts: seeding the engine is
  // synchronous, so the canvas never paints half a file. Large documents live in
  // IndexedDB, which is only readable asynchronously — hence this small state
  // machine rather than a direct render.
  const [seed, setSeed] = useState<{ id: string; doc: DocSeed | null; missing: boolean } | null>(null);

  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // A pre-dashboard autosave becomes a Draft rather than vanishing behind the
  // new front door, and a brand-new store gets the bundled sample file.
  useEffect(() => {
    if (route.view === "home") {
      ensureDemoFile();
      migrateLegacyDoc();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (route.view !== "file") {
      setSeed(null);
      return;
    }
    const sync = readDocSync(route.id);
    if (sync) {
      setSeed({ id: route.id, doc: sync, missing: false });
      return;
    }
    let alive = true;
    setSeed(null);
    readDoc(route.id)
      .then((doc) => {
        if (!alive) return;
        // An id that was never stored opens as a scratch document — that is how
        // a direct link to a file in another browser should behave, and it is
        // what the e2e harness drives. An id that exists but whose bytes are
        // gone must NOT be overwritten by a blank file.
        setSeed({ id: route.id, doc: doc ?? null, missing: !!doc === false && !!getFile(route.id) });
      })
      .catch(() => {
        if (alive) setSeed({ id: route.id, doc: null, missing: !!getFile(route.id) });
      });
    return () => {
      alive = false;
    };
  }, [route]);

  if (route.view === "file") {
    if (seed && seed.missing) {
      return (
        <div className="open-screen">
          <div className="open-card">
            <b>This file is not in this browser</b>
            <span>Its document is stored locally, and nothing was found here. Start a new file instead.</span>
            <button className="primary" onClick={() => (window.location.hash = "#/")}>
              Back to files
            </button>
          </div>
        </div>
      );
    }
    if (!seed || seed.id !== route.id) {
      return (
        <div className="open-screen">
          <div className="open-card">
            <b>Opening file…</b>
            <span>Reading the document from local storage.</span>
          </div>
        </div>
      );
    }
    return (
      <Editor
        key={route.id}
        fileId={route.id}
        seed={seed.doc}
        onHome={() => {
          window.location.hash = "#/";
        }}
      />
    );
  }
  return <Dashboard onOpen={(id) => (window.location.hash = `#/file/${encodeURIComponent(id)}`)} />;
}

/** A file link, narrowed to one layer when exactly one is selected, so the
 *  receiver opens on that layer rather than somewhere on the page. */
function linkForSelection(snap: { selection: string[] }, fileId: string): string {
  const base = `#/file/${encodeURIComponent(fileId)}`;
  const one = snap.selection.length === 1 ? snap.selection[0] : null;
  return `${window.location.origin}${window.location.pathname}${base}${one ? `?f=${encodeURIComponent(one)}` : ""}`;
}

function Editor({ fileId, seed, onHome }: { fileId: string; seed: DocSeed | null; onHome: () => void }) {
  const engine = useMemo(() => new MemoryEngine(!seed, seed), [seed]);
  const snap = useSyncExternalStore(
    (fn) => engine.subscribe(fn),
    () => engine.snapshot(),
    () => engine.snapshot(),
  );
  const [nav, setNav] = useState<NavId>("file");
  const [leftW, setLeftW] = useState(240);
  const [rightW, setRightW] = useState(240);
  const [minUi, setMinUi] = useState(false);
  const [hideUi, setHideUi] = useState(false);
  const [actions, setActions] = useState(false);
  const [figInspector, setFigInspector] = useState(false);
  const [toast, setToast] = useState("");
  const runnerRef = useRef<((ix: any) => void) | null>(null);
  const leftDrag = usePanelDrag(leftW, setLeftW, 180, 420);
  const rightDrag = usePanelDrag(rightW, setRightW, 200, 420, true);

  // Autosave. The document is serialised on a trailing debounce so a burst of
  // edits (dragging, typing) writes once when it settles rather than on every
  // dispatch, and again on pagehide to catch a close mid-burst.
  useEffect(() => {
    let timer = 0;
    let warned = false;
    const write = () => {
      const doc = engine.toDoc();
      const status = saveDoc(doc);
      try {
        saveFile(fileId, doc as never);
      } catch {
        /* the per-file index is a convenience; the autosave above is the copy */
      }
      if (status !== "saved" && !warned) {
        warned = true; // one warning per session, not once per keystroke
        toastMsg(
          status === "quota"
            ? "Document too large to autosave · export to keep a copy"
            : "Autosave unavailable in this browser",
        );
      }
      if (status === "saved") warned = false;
    };
    const off = engine.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(write, 600);
    });
    const flush = () => {
      window.clearTimeout(timer);
      write();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      off();
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [engine, fileId]);

  // If a stored document existed but could not be read, say so rather than
  // silently presenting an empty file as if nothing was lost. This sets the
  // toast state directly: the bus subscription below mounts after this effect,
  // so a message raised through the bus here would be dropped.
  useEffect(() => {
    if (!engine.restoreFailed) return;
    setToast("Saved document could not be read · started a new one");
    const t = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(t);
  }, [engine]);

  // Any module can raise a toast via the bus; keep the existing local setter
  // working for the share button.
  useEffect(() => {
    let timer = 0;
    const off = subscribeToast((msg) => {
      setToast(msg);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setToast(""), 1800);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);

  // The zoom menu offers "Hide UI", which is this component's state, so it asks
  // through an event rather than threading another prop through the inspector.
  // ⇧⌘E's bulk export sheet. The flag lives here, not in the panel, because
  // Escape has to be resolved by the central hotkey handler: listeners a modal
  // attaches itself are starved by the app's own capture-phase handler.
  const [exportOpen, setExportOpen] = useState(false);
  const overlayRef = useRef({ exportOpen, actions, figInspector });
  // Handoff plumbing that needs the live document: land on the layer a shared
  //  link points at, then answer the two copy commands the menu asks for.
  useEffect(() => {
    const linked = /[?&]f=([^/?#]+)/.exec(window.location.hash || "");
    if (!linked) return undefined;
    const id = decodeURIComponent(linked[1]);
    let tries = 0;
    let timer = 0;
    // The node lives in whichever page the file last had open, so search every
    // page and switch if the link points elsewhere. Retrying covers the first
    // paint, where the restored page index and the tree land in the same tick.
    const attempt = () => {
      const s = engine.snapshot();
      const at = s.pages.findIndex((pg) => !!worldPos(pg.root, id));
      if (at < 0) {
        if (++tries < 3) {
          timer = window.setTimeout(attempt, 220);
          return false;
        }
        // Say so: a link that silently opens the wrong view is worse than one
        // that admits the layer is not in this copy of the file.
        setToast("That link points at a layer this copy of the file does not have");
        window.setTimeout(() => setToast(""), 3200);
        return false;
      }
      if (at !== s.page) engine.dispatch({ type: "setPage", index: at });
      engine.dispatch({ type: "select", ids: [id] });
      zoomTo(engine, "selection");
      return true;
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [engine]);
  useEffect(() => {
    const selected = () => {
      const s = engine.snapshot();
      const id = s.selection[0];
      return id ? worldPos(s.pages[s.page].root, id)?.node ?? null : null;
    };
    const flash = (msg: string) => {
      setToast(msg);
      window.setTimeout(() => setToast(""), 1800);
    };
    const onCopyLink = () => {
      const s = engine.snapshot();
      if (!s.selection.length) flash("Select a layer first · this link opens one layer");
      else {
        copyText(linkForSelection(s, fileId));
        flash(s.selection.length === 1 ? "Link to that layer copied" : "Link copied · opens this file");
      }
    };
    const onCopyPng = () => {
      const node = selected();
      if (!node) flash("Select a layer to copy it as a PNG");
      else copyPng(node);
    };
    window.addEventListener("x-native-copy-link", onCopyLink);
    window.addEventListener("x-native-copy-png", onCopyPng);
    return () => {
      window.removeEventListener("x-native-copy-link", onCopyLink);
      window.removeEventListener("x-native-copy-png", onCopyPng);
    };
  }, [engine, fileId]);

  overlayRef.current = { exportOpen, actions, figInspector };
  const closeOverlay = () => {
    const o = overlayRef.current;
    if (o.exportOpen) setExportOpen(false);
    else if (o.actions) setActions(false);
    else if (o.figInspector) setFigInspector(false);
    else return false;
    return true;
  };
  useEffect(() => {
    const on = () => setHideUi((v) => !v);
    const onMin = () => setMinUi((v) => !v);
    const onExport = () => setExportOpen(true);
    window.addEventListener("x-native-hide-ui", on);
    window.addEventListener("x-native-minimize-ui", onMin);
    window.addEventListener("x-native-export-dialog", onExport);
    return () => {
      window.removeEventListener("x-native-hide-ui", on);
      window.removeEventListener("x-native-minimize-ui", onMin);
      window.removeEventListener("x-native-export-dialog", onExport);
    };
  }, []);

  const share = () => {
    const page = snap.pages[snap.page];
    // The clipboard gets the link alone — a recipient pastes it into Slack or a
    // ticket and it stays clickable. The file/page names are in the message.
    // The button shares the *file*; a link to one layer comes from the layer's
    // own right-click menu, so a teammate never receives a deep link by accident.
    copyText(`${window.location.origin}${window.location.pathname}#/file/${encodeURIComponent(fileId)}`);
    setToast(`Link copied — opens ${snap.fileName} · ${page.name}`);
    window.setTimeout(() => setToast(""), 1600);
  };
  const present = () => {
    engine.dispatch({ type: "presentStart" });
    setHideUi(true);
    setToast("Presenting — click hotspots, Esc to go back");
    window.setTimeout(() => setToast(""), 1800);
  };

  useEffect(
    () =>
      bindHotkeys(engine, {
        onActions: () => setActions(true),
        onHide: () => setHideUi((v) => !v),
        onMinimize: () => setMinUi((v) => !v),
        onNav: setNav,
        onEscapeOverlay: closeOverlay,
        onPresentExit: () => {
          const s = engine.snapshot();
          if (s.presentFrame) {
            if (s.activeOverlay) {
              engine.dispatch({ type: "closeOverlay" });
            } else if (s.presentStack.length > 1) {
              engine.dispatch({ type: "presentBack" });
            } else {
              engine.dispatch({ type: "presentStop" });
              setHideUi(false);
            }
          }
        },
      }),
    [engine],
  );

  const cls = [
    "app",
    minUi ? "min-ui" : "",
    minUi && !snap.selection.length ? "no-sel" : "",
    hideUi ? "hide-ui" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      style={{ ["--left-w" as string]: `${leftW}px`, ["--right-w" as string]: `${rightW}px` }}
    >
      <NavRail
        engine={engine}
        nav={nav}
        setNav={setNav}
        onActions={() => setActions(true)}
        onInspectFig={() => setFigInspector(true)}
        onHome={onHome}
      />
      <LeftPanel
        engine={engine}
        snap={snap}
        nav={nav}
        onMinimize={() => setMinUi((v) => !v)}
        onActions={() => setActions(true)}
        onHome={onHome}
      />
      <div
        className="split l"
        style={{ display: minUi || hideUi ? "none" : undefined }}
        {...leftDrag}
      />
      <div className="canvas-col">
        {minUi && !hideUi && !snap.presentFrame && (
          // Figma keeps the file name and a way out of the minimized state on
          // screen; ours lives at the top of the left panel, which is hidden
          // here, so the same two controls float in its place.
          <div className="min-chip">
            <button className="icon-btn" title="Back to files" onClick={onHome}>
              <Icon name="back" size={14} />
            </button>
            <span className="min-chip-name" title="UI minimized · ⇧⌘\ restores the panels">
              {snap.fileName}
            </span>
            <button className="icon-btn" title="Restore UI (⇧⌘\)" onClick={() => setMinUi(false)}>
              <Icon name="minimize" size={14} />
            </button>
          </div>
        )}
        <Canvas
          engine={engine}
          snap={snap}
          onRunInteraction={(runner) => {
            runnerRef.current = runner;
          }}
        />
        {snap.presentFrame ? (
          <PresentationPlayer
            engine={engine}
            snap={snap}
            onInteraction={(ix) => {
              if (runnerRef.current) runnerRef.current(ix);
            }}
            onExit={() => {
              engine.dispatch({ type: "presentStop" });
              setHideUi(false);
            }}
          />
        ) : (
          <>
            <Toolbar engine={engine} snap={snap} onActions={() => setActions(true)} />
            <HelpBtn />
          </>
        )}
        {actions && (
          <Actions
            engine={engine}
            onPresent={present}
            onClose={() => setActions(false)}
            onHide={() => {
              setHideUi((v) => !v);
              setActions(false);
            }}
            onMinimize={() => {
              setMinUi((v) => !v);
              setActions(false);
            }}
            onInspectFig={() => {
              setFigInspector(true);
              setActions(false);
            }}
          />
        )}
      </div>
      <RightPanel
        engine={engine}
        snap={snap}
        onPresent={present}
        onShare={share}
        exportOpen={exportOpen}
        onCloseExport={() => setExportOpen(false)}
      />
      <div className="split r" style={{ display: hideUi ? "none" : undefined }} {...rightDrag} />
      {toast && <div className="toast">{toast}</div>}
      {figInspector && <FigInspectorModal engine={engine} onClose={() => setFigInspector(false)} />}
    </div>
  );
}
