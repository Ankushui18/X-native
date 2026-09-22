import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { MemoryEngine } from "./engine/memory";
import { Canvas } from "./ui/Canvas";
import { copyText } from "./engine/clipboard";
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
import { RightPanel } from "./ui/inspector";
import { subscribeToast } from "./ui/toast";

export default function App() {
  const engine = useMemo(() => new MemoryEngine(), []);
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
  const [toast, setToast] = useState("");
  const leftDrag = usePanelDrag(leftW, setLeftW, 180, 420);
  const rightDrag = usePanelDrag(rightW, setRightW, 200, 420, true);

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

  const share = () => {
    const page = snap.pages[snap.page];
    const text = `${snap.fileName} · ${page.name} · ${window.location.href}`;
    copyText(text);
    setToast("Link copied");
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
        onPresentExit: () => {
          const s = engine.snapshot();
          if (s.presentFrame) {
            if (s.presentStack.length > 1) engine.dispatch({ type: "presentBack" });
            else {
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
      <NavRail engine={engine} nav={nav} setNav={setNav} onActions={() => setActions(true)} />
      <LeftPanel
        engine={engine}
        snap={snap}
        nav={nav}
        onMinimize={() => setMinUi((v) => !v)}
        onActions={() => setActions(true)}
      />
      <div
        className="split l"
        style={{ display: minUi || hideUi ? "none" : undefined }}
        {...leftDrag}
      />
      <div className="canvas-col">
        <Canvas engine={engine} snap={snap} />
        <Toolbar engine={engine} snap={snap} onActions={() => setActions(true)} />
        <HelpBtn />
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
          />
        )}
      </div>
      <RightPanel engine={engine} snap={snap} onPresent={present} onShare={share} />
      <div className="split r" style={{ display: hideUi ? "none" : undefined }} {...rightDrag} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
