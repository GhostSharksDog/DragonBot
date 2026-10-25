import type { Activity, SkinManifest } from './types';

type Motion = 'idle' | 'walking' | 'running';
type Direction = 'left' | 'right';

/** The clock follows the action actually drawn, including an idle fallback. */
export function effectiveAnimationKey(manifest: SkinManifest | null | undefined, activity: Activity, motion: Motion, direction: Direction): string {
  const state = activity === 'idle' ? motion : activity;
  const requested = state === 'walking' || state === 'running' ? `${state}-${direction}` : state;
  return manifest?.rig || manifest?.animations[requested] ? requested : 'idle';
}

/** Keep an unfinished stationary skin at rest rather than sliding its idle pose. */
export function roamingAnimationMotion(manifest: SkinManifest | null | undefined): Exclude<Motion, 'idle'> | null {
  if (!manifest) return null;
  if (manifest.rig) return 'running';
  if (manifest.animations['running-left'] && manifest.animations['running-right']) return 'running';
  if (manifest.animations['walking-left'] && manifest.animations['walking-right']) return 'walking';
  return null;
}
