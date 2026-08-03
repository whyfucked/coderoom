import { write } from './ansi.mjs';

let owner = null;

export function claim(handler) {
  const prev = owner;
  owner = handler;
  return () => {
    if (owner === handler) owner = prev;
  };
}

export function notify(text, ttl = 2500) {
  if (!text) return;
  if (owner?.notify) return owner.notify(text, ttl);
  write('\n' + text + '\n');
}

export const hasOwner = () => Boolean(owner);
