/**
 * 低版本 Node.js 没有 Promise.try 时的替代实现。
 *
 * 仅适用于异步函数（含同步抛错）。
 */
export function PromiseTry<T extends (...args: any[]) => any>(fn: T, ...args: Parameters<T>) {
  return new Promise<ReturnType<T>>((resolve, reject) => {
    // fn 同步抛错时也要转成 reject
    try {
      const r = fn(...args);
      if (r instanceof Promise) {
        r.then(resolve).catch(reject);
      } else {
        resolve(r);
      }
    } catch (e) {
      reject(e);
    }
  });
}
