import { fluxion } from '../dist/index.mjs';

// 通过了三轮测试：
// 1、dyn/333.ts可以正常返回
// 2、及时修改333.ts内容，成功变化
// 3、增加outdata.ts，改变引入，333.ts的返回也变化
fluxion({
  dir: process.env.DYNAMIC_DIRECTORY ?? 'examples/hotapis',
  host: process.env.HOST ?? 'localhost',
  port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000,
});
