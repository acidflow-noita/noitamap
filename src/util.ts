import { i18n } from 'i18next';
import { Spell } from './data_sources/overlays';

/**
 * Returns a function that debounces calls to `func` by `delay` milliseconds:
 *
 * @example
 * ```ts
 * const rateLimited = debounce(100, fetchURL);
 *
 * for (let i = 0; i < 10; i++) {
 *    // will only get called once, with q=9, 100ms after this loop executes
 *    rateLimited(`https://google.com?q=${i}`);
 *    // will get called 10 times, immediately with q=0 through q=9
 *    fetchURL(`https://google.com?q=${i}`);
 * }
 * ```
 *
 * @param delay Call `func` no more frequently than every `delay` milliseconds
 * @param func The function to call
 * @returns
 */
export const debounce = <Arg extends any, Args extends Arg[]>(delay: number, func: (...args: Args) => void) => {
  let latest: Args = [] as unknown as Args;
  let timer: NodeJS.Timeout | undefined = undefined;

  return (...args: Args) => {
    latest = args;
    timer ??= setTimeout(() => {
      timer = undefined;
      func(...latest);
    }, delay);
  };
};

export const assertElementById = <T extends typeof HTMLElement>(id: string, cls: T): InstanceType<T> => {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`assertElementById: no element found with id='${id}'`);
  }
  if (!(found instanceof cls)) {
    throw new Error(
      `assertElementById: element with id='${id}' is a '${(found as any).constructor.name}'; expected ${cls.name}`
    );
  }
  return found as InstanceType<T>;
};

export const addEventListenerForId = <K extends keyof HTMLElementEventMap>(
  id: string,
  type: K,
  listener: (this: HTMLElement, ev: HTMLElementEventMap[K] & { target: HTMLElement }) => any,
  options?: boolean | AddEventListenerOptions
) => {
  const el = document.getElementById(id);
  if (!el) {
    const err = new Error(`addEventListenerById: no element found with id='${id}'`);
    console.error(err);
    return;
  }

  el.addEventListener(type, function (event) {
    if (!(event.target instanceof HTMLElement)) return;
    listener.call(this, event as HTMLElementEventMap[K] & { target: HTMLElement });
  });
};

export const formatDate = (d: string) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(d));

export const getSpellAvailability = (spell: Spell, i18next: i18n): string => {
  if (!spell.isWandSpell && !spell.isPremadeWandSpell) {
    return i18next.t('shops_only', 'Shops only');
  } else if (!spell.isWandSpell && spell.isPremadeWandSpell) {
    return i18next.t('shops_wands_in_mines', 'Shops; wands in Mines');
  }
  return i18next.t('shops_and_wands', 'Shops and wands');
};
