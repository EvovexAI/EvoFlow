"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

const STORAGE_KEY = "ai-site-sound";

let soundEnabled = false;

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function getSnapshot() { return soundEnabled; }

function notifyAll() {
  for (const cb of listeners) cb();
}

export function useSoundEnabled() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function useToggleSound() {
  return useCallback(() => {
    soundEnabled = !soundEnabled;
    try { localStorage.setItem(STORAGE_KEY, soundEnabled ? "1" : "0"); } catch {}
    notifyAll();
  }, []);
}

// Hydrate from localStorage once on client
if (typeof window !== "undefined") {
  try {
    soundEnabled = localStorage.getItem(STORAGE_KEY) === "1";
  } catch {}
}

const audioCtxRef: { current: AudioContext | null } = { current: null };

function getAudioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtxRef.current) {
    try { audioCtxRef.current = new AudioContext(); } catch { return null; }
  }
  if (audioCtxRef.current.state === "suspended") {
    audioCtxRef.current.resume().catch(() => {});
  }
  return audioCtxRef.current;
}

type SoundType = "hover" | "click" | "navigate" | "success";

const SOUND_CONFIGS: Record<SoundType, { freq: number; duration: number; gain: number; type: OscillatorType }> = {
  hover:    { freq: 880,  duration: 0.04, gain: 0.03, type: "sine" },
  click:    { freq: 660,  duration: 0.06, gain: 0.05, type: "sine" },
  navigate: { freq: 520,  duration: 0.10, gain: 0.04, type: "triangle" },
  success:  { freq: 780,  duration: 0.12, gain: 0.05, type: "sine" },
};

function playTone(sound: SoundType) {
  if (!soundEnabled) return;
  const ctx = getAudioCtx();
  if (!ctx) return;

  const config = SOUND_CONFIGS[sound];
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = config.type;
  osc.frequency.setValueAtTime(config.freq, ctx.currentTime);

  if (sound === "success") {
    osc.frequency.linearRampToValueAtTime(1040, ctx.currentTime + config.duration);
  }

  gain.gain.setValueAtTime(config.gain, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + config.duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + config.duration + 0.01);
}

export function usePlaySound() {
  return useCallback((sound: SoundType) => {
    playTone(sound);
  }, []);
}

/**
 * Plays the navigate sound on pathname change.
 */
export function useSoundOnNavigate(pathname: string) {
  const prevRef = useRef(pathname);
  useEffect(() => {
    if (prevRef.current !== pathname) {
      prevRef.current = pathname;
      playTone("navigate");
    }
  }, [pathname]);
}
