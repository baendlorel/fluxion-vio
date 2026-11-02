import { defineFluxionModule } from '../../src/index.js';

export default defineFluxionModule({
  handler: async (req) => {
    return req.url.pathname + '成功';
  },
});
