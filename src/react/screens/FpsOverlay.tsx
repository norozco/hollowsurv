// FPS / debug overlay. Toggle with F3. Top-right corner. Default OFF.
//
// Renders:
//   - FPS (averaged over the last 60 sampled frames)
//   - Frame time (ms, averaged)
//   - JS heap usage (MB) — only on browsers that expose `performance.memory`
//     (Chromium-family). We feature-detect; on Firefox/Safari the row is hidden.
//
// State model:
//   - Visibility lives in local component state (re-toggleable via F3). It is
//     intentionally NOT persisted to metaStore — this is a debug toggle, not a
//     user-facing setting, so it shouldn't survive reloads.
//   - Mounted unconditionally from App.tsx. When hidden it returns null and the
//     rAF sampling loop is paused, so its cost when off is one keydown listener.
//
// Sampling: we drive a requestAnimationFrame loop while visible. Each frame we
// record the delta since the previous frame into a ring buffer of length 60.
// The displayed FPS/frame-time are the average across the buffer; the update
// itself happens twice per second so the numbers are readable rather than
// flickering every frame.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

const SAMPLE_COUNT = 60;
const UPDATE_INTERVAL_MS = 500;

// Chromium-only API. Not in the lib.dom.d.ts types, so we narrow with our own.
interface PerformanceWithMemory {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

function readMemoryMb(): number | null {
  const perf = performance as PerformanceWithMemory;
  if (!perf.memory) return null;
  return perf.memory.usedJSHeapSize / 1048576;
}

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  top: 8,
  right: 8,
  zIndex: 50,
  pointerEvents: 'none',
  background: 'rgba(10, 10, 18, 0.78)',
  border: '1px solid #2a2a3a',
  borderRadius: 4,
  padding: '6px 10px',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
  color: '#cfd',
  lineHeight: 1.5,
  minWidth: 120,
  fontVariantNumeric: 'tabular-nums',
};

const ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '60px 1fr',
  gap: 8,
};

const LABEL_STYLE: CSSProperties = {
  opacity: 0.6,
};

const FOOTER_STYLE: CSSProperties = {
  marginTop: 4,
  paddingTop: 4,
  borderTop: '1px solid #2a2a3a',
  fontSize: 10,
  opacity: 0.5,
  textAlign: 'right',
};

export function FpsOverlay(): ReactElement | null {
  const [visible, setVisible] = useState<boolean>(false);
  const [fps, setFps] = useState<number>(0);
  const [frameMs, setFrameMs] = useState<number>(0);
  const [memoryMb, setMemoryMb] = useState<number | null>(null);

  // Toggle on F3 (capture both the modern `key` and the codename for older
  // browsers). Stops the keydown from propagating so the game doesn't react.
  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'F3' || ev.code === 'F3') {
        ev.preventDefault();
        setVisible((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Frame-time sampling loop. Only runs while visible.
  const samples = useRef<number[]>([]);
  const sampleIdx = useRef<number>(0);
  const lastFrameTs = useRef<number>(0);
  const lastUiUpdate = useRef<number>(0);

  useEffect(() => {
    if (!visible) {
      // Reset buffers when the overlay closes so the next open starts clean.
      samples.current = [];
      sampleIdx.current = 0;
      lastFrameTs.current = 0;
      lastUiUpdate.current = 0;
      return;
    }

    let rafId = 0;
    let cancelled = false;

    const tick = (ts: number): void => {
      if (cancelled) return;
      if (lastFrameTs.current !== 0) {
        const dt = ts - lastFrameTs.current;
        if (samples.current.length < SAMPLE_COUNT) {
          samples.current.push(dt);
        } else {
          samples.current[sampleIdx.current] = dt;
          sampleIdx.current = (sampleIdx.current + 1) % SAMPLE_COUNT;
        }
      }
      lastFrameTs.current = ts;

      // Throttle React state updates to UPDATE_INTERVAL_MS so the numbers don't
      // shimmer 60x/sec.
      if (ts - lastUiUpdate.current >= UPDATE_INTERVAL_MS) {
        lastUiUpdate.current = ts;
        const buf = samples.current;
        if (buf.length > 0) {
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] as number;
          const avg = sum / buf.length;
          setFrameMs(avg);
          setFps(avg > 0 ? 1000 / avg : 0);
        }
        setMemoryMb(readMemoryMb());
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div style={ROOT_STYLE}>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>FPS</span>
        <span>{fps.toFixed(0)}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>Frame</span>
        <span>{frameMs.toFixed(2)} ms</span>
      </div>
      {memoryMb !== null ? (
        <div style={ROW_STYLE}>
          <span style={LABEL_STYLE}>Heap</span>
          <span>{memoryMb.toFixed(1)} MB</span>
        </div>
      ) : null}
      <div style={FOOTER_STYLE}>F3 to hide</div>
    </div>
  );
}
