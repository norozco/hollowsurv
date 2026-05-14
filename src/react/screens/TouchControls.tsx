// On-screen virtual controls for touch devices.
// Owner: Agent C5 (mobile input).
//
// Mounts only on touch-capable devices and only while phase === 'playing'.
// Two thumb zones:
//   - Bottom-left circle (140px): virtual joystick — drag to set move vector.
//     Touch origin is captured on touchstart; touchmove computes (dx, dy)
//     relative to origin, clamped to JOYSTICK_RADIUS, normalized to [-1, 1].
//   - Bottom-right circle: aim. Short tap = toggle manual aim (like C key).
//     Long touch (>200ms or any drag past TAP_RADIUS) = hold to aim in that
//     direction. The angle is computed from touch position relative to the
//     circle center.
//
// Pointer-events:
//   - Root wrapper: pointer-events: none — does NOT intercept Phaser canvas
//     touches (e.g. somebody tapping middle of screen to scroll the page is
//     unaffected).
//   - Each circle element: pointer-events: auto — only the circles themselves
//     consume touches.
//
// The two circles use independent touch tracking via touch.identifier so the
// joystick and aim can be held simultaneously by left + right thumbs.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useRunStore } from '../../stores/runStore';
import {
  clearMove,
  hasTouch,
  setAim,
  setMove,
  tapToggleAim,
} from '../../core/touchInput';

/** Joystick visual diameter in pixels. */
const JOYSTICK_DIAMETER = 140;
/** Joystick max stick travel from center in pixels. */
const JOYSTICK_RADIUS = 60;
/** Aim circle visual diameter in pixels. */
const AIM_DIAMETER = 120;
/** A press shorter than this AND smaller than TAP_RADIUS is a "tap" (toggle). */
const TAP_MAX_MS = 200;
/** A press that moves further than this becomes a "drag" (hold-to-aim). */
const TAP_MAX_RADIUS = 12;

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none', // wrapper must NOT eat Phaser canvas touches
  zIndex: 12,
  fontFamily: 'system-ui, sans-serif',
  // touchAction:none on this wrapper would block scroll on its children, but
  // children set their own touchAction below.
};

const JOY_BASE_STYLE: CSSProperties = {
  position: 'absolute',
  left: 24,
  bottom: 24,
  width: JOYSTICK_DIAMETER,
  height: JOYSTICK_DIAMETER,
  borderRadius: '50%',
  background: 'rgba(255, 255, 255, 0.08)',
  border: '2px solid rgba(255, 255, 255, 0.25)',
  pointerEvents: 'auto',
  touchAction: 'none', // block native gesture handling inside the joystick
  // Center children:
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const JOY_STICK_STYLE: CSSProperties = {
  width: JOYSTICK_DIAMETER * 0.45,
  height: JOYSTICK_DIAMETER * 0.45,
  borderRadius: '50%',
  background: 'rgba(255, 255, 255, 0.35)',
  border: '2px solid rgba(255, 255, 255, 0.6)',
  pointerEvents: 'none', // stick is purely visual; the base handles touches
};

const AIM_BASE_STYLE: CSSProperties = {
  position: 'absolute',
  right: 24,
  bottom: 24,
  width: AIM_DIAMETER,
  height: AIM_DIAMETER,
  borderRadius: '50%',
  background: 'rgba(255, 80, 80, 0.08)',
  border: '2px solid rgba(255, 80, 80, 0.25)',
  pointerEvents: 'auto',
  touchAction: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(255, 200, 200, 0.6)',
  fontSize: 12,
  letterSpacing: 1,
  textTransform: 'uppercase',
  userSelect: 'none',
};

const AIM_LABEL_STYLE: CSSProperties = {
  pointerEvents: 'none',
};

/**
 * On-screen virtual joystick + aim circle for touch devices. Renders nothing on
 * non-touch devices or outside the 'playing' phase.
 */
export function TouchControls(): ReactElement | null {
  const phase = useRunStore((s) => s.phase);

  // Stable refs for the joystick/aim circles so we can read their bounding
  // rects in event handlers without forcing re-renders.
  const joyBaseRef = useRef<HTMLDivElement | null>(null);
  const aimBaseRef = useRef<HTMLDivElement | null>(null);

  // Stick visual offset (purely cosmetic — drives `transform` on the inner
  // circle). useState to trigger re-render on touch move.
  const [stickOffset, setStickOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [aimVisible, setAimVisible] = useState<boolean>(false);

  // Per-touch tracking. Maps identifier → role + state. Refs (not state) so
  // updates don't trigger re-renders during touchmove.
  const joyTouchIdRef = useRef<number | null>(null);
  const joyOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const aimTouchIdRef = useRef<number | null>(null);
  const aimStartTimeRef = useRef<number>(0);
  const aimStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const aimDraggingRef = useRef<boolean>(false);

  // Feature detect on first render; bail entirely on non-touch devices so we
  // don't pollute desktop UI with the joystick.
  const isTouchDevice = hasTouch();

  // --- joystick handlers ---------------------------------------------------
  useEffect(() => {
    const el = joyBaseRef.current;
    if (!el) return;

    function onTouchStart(ev: TouchEvent): void {
      // Only grab a touch if we don't already have one.
      if (joyTouchIdRef.current !== null) return;
      const t = ev.changedTouches[0];
      if (!t) return;
      ev.preventDefault();
      joyTouchIdRef.current = t.identifier;
      // Origin = the center of the joystick base, not the touch point itself.
      // This way the user can place their thumb anywhere inside the circle and
      // drag from there, which feels more natural than "tap-to-anchor".
      const rect = el!.getBoundingClientRect();
      joyOriginRef.current = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      // Push initial offset (which is whatever direction the thumb landed
      // relative to center — gives immediate feedback for tap-and-flick).
      computeAndPush(t.clientX, t.clientY);
    }

    function onTouchMove(ev: TouchEvent): void {
      const id = joyTouchIdRef.current;
      if (id === null) return;
      // Find the touch with our id.
      for (let i = 0; i < ev.changedTouches.length; i++) {
        const t = ev.changedTouches[i];
        if (t && t.identifier === id) {
          ev.preventDefault();
          computeAndPush(t.clientX, t.clientY);
          return;
        }
      }
    }

    function onTouchEnd(ev: TouchEvent): void {
      const id = joyTouchIdRef.current;
      if (id === null) return;
      for (let i = 0; i < ev.changedTouches.length; i++) {
        const t = ev.changedTouches[i];
        if (t && t.identifier === id) {
          ev.preventDefault();
          joyTouchIdRef.current = null;
          clearMove();
          setStickOffset({ x: 0, y: 0 });
          return;
        }
      }
    }

    function computeAndPush(clientX: number, clientY: number): void {
      const dx = clientX - joyOriginRef.current.x;
      const dy = clientY - joyOriginRef.current.y;
      const len = Math.hypot(dx, dy);
      // Clamp to max radius; rescale visual offset to clamped value.
      const clampedLen = Math.min(len, JOYSTICK_RADIUS);
      const visX = len > 0 ? (dx / len) * clampedLen : 0;
      const visY = len > 0 ? (dy / len) * clampedLen : 0;
      setStickOffset({ x: visX, y: visY });
      // Normalize to [-1, 1] using clamped length so values past radius cap at 1.
      const normX = visX / JOYSTICK_RADIUS;
      const normY = visY / JOYSTICK_RADIUS;
      setMove(normX, normY);
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isTouchDevice, phase]);

  // --- aim circle handlers -------------------------------------------------
  useEffect(() => {
    const el = aimBaseRef.current;
    if (!el) return;

    function onTouchStart(ev: TouchEvent): void {
      if (aimTouchIdRef.current !== null) return;
      const t = ev.changedTouches[0];
      if (!t) return;
      ev.preventDefault();
      aimTouchIdRef.current = t.identifier;
      aimStartTimeRef.current = performance.now();
      aimStartPosRef.current = { x: t.clientX, y: t.clientY };
      aimDraggingRef.current = false;
    }

    function onTouchMove(ev: TouchEvent): void {
      const id = aimTouchIdRef.current;
      if (id === null) return;
      for (let i = 0; i < ev.changedTouches.length; i++) {
        const t = ev.changedTouches[i];
        if (t && t.identifier === id) {
          ev.preventDefault();
          // Promote to "drag" if moved past TAP_MAX_RADIUS — this stays a drag
          // for the rest of the gesture.
          const start = aimStartPosRef.current;
          const dx0 = t.clientX - start.x;
          const dy0 = t.clientY - start.y;
          if (Math.hypot(dx0, dy0) > TAP_MAX_RADIUS) {
            aimDraggingRef.current = true;
          }
          if (aimDraggingRef.current) {
            // Compute angle from the AIM CIRCLE CENTER (not the start point),
            // matching how a thumbstick's deflection feels.
            const rect = el!.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const adx = t.clientX - cx;
            const ady = t.clientY - cy;
            const len = Math.hypot(adx, ady);
            if (len > 0.0001) {
              const inv = 1 / len;
              setAim(true, adx * inv, ady * inv);
              setAimVisible(true);
            }
          }
          return;
        }
      }
    }

    function onTouchEnd(ev: TouchEvent): void {
      const id = aimTouchIdRef.current;
      if (id === null) return;
      for (let i = 0; i < ev.changedTouches.length; i++) {
        const t = ev.changedTouches[i];
        if (t && t.identifier === id) {
          ev.preventDefault();
          // Decide: tap vs drag.
          const dur = performance.now() - aimStartTimeRef.current;
          const start = aimStartPosRef.current;
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          const moved = Math.hypot(dx, dy);
          const wasDragging = aimDraggingRef.current;
          // Reset state first.
          aimTouchIdRef.current = null;
          aimDraggingRef.current = false;
          setAim(false, 0, 0);
          setAimVisible(false);
          // Short, low-motion press = toggle manual aim.
          if (!wasDragging && dur < TAP_MAX_MS && moved < TAP_MAX_RADIUS) {
            tapToggleAim();
          }
          return;
        }
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isTouchDevice, phase]);

  // --- safety: defensively clear move + aim on unmount or phase change -----
  useEffect(() => {
    return () => {
      clearMove();
      setAim(false, 0, 0);
    };
  }, [phase]);

  if (!isTouchDevice) return null;
  if (phase !== 'playing') return null;

  return (
    <div style={ROOT_STYLE} aria-hidden="true">
      <div ref={joyBaseRef} style={JOY_BASE_STYLE}>
        <div
          style={{
            ...JOY_STICK_STYLE,
            transform: `translate(${stickOffset.x}px, ${stickOffset.y}px)`,
            transition: stickOffset.x === 0 && stickOffset.y === 0 ? 'transform 80ms ease-out' : 'none',
          }}
        />
      </div>
      <div
        ref={aimBaseRef}
        style={{
          ...AIM_BASE_STYLE,
          background: aimVisible ? 'rgba(255, 80, 80, 0.22)' : AIM_BASE_STYLE.background,
          borderColor: aimVisible ? 'rgba(255, 80, 80, 0.65)' : 'rgba(255, 80, 80, 0.25)',
        }}
      >
        <span style={AIM_LABEL_STYLE}>aim</span>
      </div>
    </div>
  );
}
