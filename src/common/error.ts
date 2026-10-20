export class FluxionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FluxionVioError';
  }
}
