/**
 * The user's own toolbar tab: a name and a list of tools, kept in this
 * computer's local storage.
 */

import { RENAMED } from './catalog';

export interface CustomTab {
  name: string;
  /** Catalog labels, in the order they appear. */
  labels: string[];
}

const KEY = 'folio.customTab';
export const CUSTOM_TAB_EVENT = 'folio:custom-tab';

export function getCustomTab(): CustomTab | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as CustomTab | null;
    if (!v || typeof v.name !== 'string' || !Array.isArray(v.labels) || !v.labels.length) return null;
    // Renamed tools keep their place; two old names for one tool become one entry.
    return { name: v.name, labels: [...new Set(v.labels.map((l) => RENAMED[l] ?? l))] };
  } catch {
    return null;
  }
}

export function setCustomTab(tab: CustomTab | null) {
  try {
    if (tab) localStorage.setItem(KEY, JSON.stringify(tab));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the tab just won't be remembered */
  }
  window.dispatchEvent(new Event(CUSTOM_TAB_EVENT));
}
