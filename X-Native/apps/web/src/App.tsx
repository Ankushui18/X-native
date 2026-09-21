import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { MemoryEngine } from "./engine/memory";
import { Canvas } from "./ui/Canvas";
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
  const leftDrag = usePanelDrag(leftW, setLeftW, 180, 420);
  const rightDrag = usePanelDrag(rightW, setRightW, 200, 420, true);

  useEffect(
    () =>
      bindHotkeys(engine, {
        onActions: () => setActions(true),
        onHide: () => setHideUi((v) => !v),
      }),
    [engine],
  );

  const cls = ["app", minUi ? "min-ui" : "", hideUi ? "hide-ui" : ""].filter(Boolean).join(" ");
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
            onClose={() => setActions(false)}
            onHide={() => {
              setHideUi((v) => !v);
              setActions(false);
            }}
          />
        )}
      </div>
      <RightPanel engine={engine} snap={snap} />
      <div className="split r" style={{ display: hideUi ? "none" : undefined }} {...rightDrag} />
    </div>
  );
}
