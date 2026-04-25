// Owned by Person C.
import type { Message } from './types';

export function send<T = unknown>(msg: Message): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response: T) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message ?? 'sendMessage failed'));
      } else {
        resolve(response);
      }
    });
  });
}
