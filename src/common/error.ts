/** 框架自身抛出的错误，与用户代码的异常区分开。 */
export class FluxionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FluxionVioError';
  }
}
