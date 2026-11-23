import { defineFluxionModule } from '../../dist/index.mjs';

export default defineFluxionModule({
  handler: async (req) => {
    return req.url.pathname + '成功';
  },
});
