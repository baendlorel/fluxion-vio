import { defineFluxionModule } from '../../../dist/index.mjs';
import { libValue } from '../lib/index.js';

export default defineFluxionModule(async (req) => {
  return req.url.pathname + 'asdfasdf成功阿斯蒂芬' + libValue;
});
