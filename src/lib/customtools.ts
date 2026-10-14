/**
 * The user's own toolbar tab: a name and a list of tools, kept in this
 * computer's local storage.
 */

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
    return v && typeof v.name === 'string' && Array.isArray(v.labels) && v.labels.length ? v : null;
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
