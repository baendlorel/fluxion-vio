import { fluxion } from '../dist/index.mjs';

fluxion({
  dir: process.env.DYNAMIC_DIRECTORY ?? 'examples/hotapis',
  host: process.env.HOST ?? 'localhost',
  port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000,
});
