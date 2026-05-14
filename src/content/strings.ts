// Localization scaffolding. All user-facing strings live here so a future
// translation pass only has to swap the table (and the `t()` lookups stay
// type-safe).
//
// Usage:
//   import { t } from '../../content/strings';
//   <h1>{t('gameTitle')}</h1>
//
// Parameters:
//   t('keyWithParam', { count: 3 }) — replaces `{count}` in the value.
//
// Migration policy:
//   - This module is the source of truth for the strings it contains.
//   - We migrate INCREMENTALLY: title screen, pause menu headers, run summary
//     headers, and the error boundary are the first wave (see the agents that
//     own those screens).
//   - Inline strings inside flavour copy (epithets, character descriptions,
//     etc.) stay in their content files until a fuller pass lands.
//   - Adding a key: add to STRINGS below; type narrows automatically.
//   - Renaming a key: search-and-replace the t('...') call sites.

export const STRINGS = {
  // --- Title / main menu --------------------------------------------------
  gameTitle: 'HOLLOWSURV',
  startRun: 'Start Run',
  dailyRun: 'Daily Run',
  setName: 'Set name',
  editName: 'Edit name',
  settings: 'Settings',
  /** Subtitle under the unlocked character grid. The trailing space is
   *  intentional — the player name is rendered in a colored span after it. */
  choosingForPrefix: 'Choosing for ',
  chooseYourCharacter: 'CHOOSE YOUR CHARACTER',
  back: 'Back',
  dailyRunHint: 'Daily seed {date} — same run for everyone today.',
  /** Today's daily best line under the title screen buttons. */
  todayBest: 'Today ({date}): {time}',
  /** Lifetime stat strip on the title screen. */
  statRuns: 'Runs: {count}',
  statWins: 'Wins: {count}',
  statLongest: 'Longest: {time}',
  /** Placeholder when a best-time is unset. */
  timeDash: '—',
  /** Locked character placeholder. */
  lockedName: '???',
  lockedLabel: 'Locked',
  startsWith: 'Starts with: {weapon}',

  // --- Pause menu ---------------------------------------------------------
  paused: 'PAUSED',
  resume: 'Resume (Esc)',
  sectionSettings: 'Settings',
  sectionControls: 'Controls',
  sectionCurrentRun: 'Current Run',
  sectionShareThisRun: 'Share This Run',
  copyBuildCodeUrl: 'Copy Build Code URL',
  endRunDanger: 'End Run (records as a loss)',
  copied: 'Copied!',
  copyFailed: 'Copy failed',
  clipboardUnavailable: 'Clipboard unavailable',

  // Pause menu — stat row labels
  labelCharacter: 'Character',
  labelTime: 'Time',
  labelKills: 'Kills',
  labelLevel: 'Level',
  labelHp: 'HP',
  labelHollow: 'Hollow',
  labelWeapons: 'Weapons',
  weaponsNone: '(none)',

  // Pause menu — controls list
  ctlMusic: 'Music',
  ctlSounds: 'Sounds',
  ctlScreenShake: 'Screen shake',
  keyMove: 'Move',
  keyManualAim: 'Toggle manual aim',
  keyAcceptBargain: "Accept Devil's Bargain",
  keyPickLevelup: 'Pick level-up choice',
  keyPause: 'Pause / Resume',
  controlsFootnote:
    'Gamepad and touch are supported automatically — left stick / joystick to move, right stick / right thumb to aim, Start / pause button to pause.',

  // --- Run summary --------------------------------------------------------
  /** Replaces 'Victory' on the run summary when the player wins. */
  victoryHeading: 'Victory',
  /** Replaces the lost-run heading on the run summary. */
  defeatedHeading: 'Defeated',
  /** Flavour line under the heading when the player wins. */
  victoryFlavor: '{title} stands above the Hollow.',
  /** Flavour line under the heading when the player loses. */
  defeatFlavor: 'Sleep well, {title}.',
  dailySeedLabel: 'DAILY SEED: {date}',
  todaysBestLabel: "Today's Best: {time}",
  /** Death recap labels. */
  killedBy: 'Killed by: {name}',
  longestCombo: 'Longest combo: ×{count}',
  damageDealt: 'Damage dealt: {n}',
  damageTaken: 'Damage taken: {n}',
  weaponsSummary: 'Weapons: {list}',
  restart: 'Restart',
  restartDaily: 'Restart Daily',
  backToMenu: 'Back to Menu',
  shareThisBuild: 'Share This Build',

  // --- Error boundary -----------------------------------------------------
  errorTitle: 'THE WORLD CRACKED',
  errorHint:
    'Something broke in the UI. Reload to start fresh — your save is intact.',
  errorReload: 'Reload',
  errorUnknown: 'Unknown error',
} as const;

export type StringKey = keyof typeof STRINGS;

/** Substitute `{name}` placeholders in a string with values from `params`. */
export function t(
  key: StringKey,
  params?: Record<string, string | number>
): string {
  let s: string = STRINGS[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
