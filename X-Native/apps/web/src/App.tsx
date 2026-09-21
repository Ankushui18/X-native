import { useEffect, useMemo, useSyncExternalStore } from "react";
import { MemoryEngine } from "./engine/memory";
import { Canvas } from "./ui/Canvas";
import { bindHotkeys, LeftPanel, RightPanel, TitleBar, Toolbar, ZoomBar } from "./ui/chrome";

export default function App() {
  const engine = useMemo(() => new MemoryEngine(), []);
  const snap = useSyncExternalStore(
    (fn) => engine.subscribe(fn),
    () => engine.snapshot(),
    () => engine.snapshot(),
  );
  useEffect(() => bindHotkeys(engine), [engine]);
  return (
    <div className="app">
      <TitleBar snap={snap} />
      <div className="workspace">
        <LeftPanel engine={engine} snap={snap} />
        <div className="canvas-col">
          <Canvas engine={engine} snap={snap} />
          <Toolbar engine={engine} snap={snap} />
          <ZoomBar engine={engine} snap={snap} />
        </div>
        <RightPanel engine={engine} snap={snap} />
      </div>
    </div>
  );
}
