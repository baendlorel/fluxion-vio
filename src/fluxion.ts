import type { FluxionContext, FluxionController, FluxionOptions, NormalizedFluxionOptions } from './types.js';

import { createLogger } from './common/logger.js';
import { type ModuleCache } from './common/loader.js';
import { redirectOutput } from './common/output.js';
import { flags } from './common/consts.js';
import { defineFluxionOptions } from './defines/options.js';
import { createServer, type ListeningServer } from './http/server.js';
import { createRouter } from './router/index.js';

// EPIC 为了更加接近原生的 php 行为，还可以采用进程运行法：把 spawn 出来的 tsx 的 stdio 捕获后直接返回。
// 类似 const result = execSync('tsx your-script.ts', { stdio: 'pipe' })，然后让接口返回 result。

/**
 * 构造返回给调用方的控制器。
 *
 * stop 是同步且幂等的：先中止实例信号（所有仍在赛跑的中间件和 handler 立即被放弃），
 * 再关闭监听并销毁剩余连接，确保没有请求能活过这次调用。
 */
function createController(cx: FluxionContext, server: ListeningServer): FluxionController {
  const stop = (): void => {
    if (cx.signal.aborted) {
      return;
    }
    cx.abort();
    cx.logger.warn({ event: 'Stopped', pid: process.pid });
    // close 停止新连接，closeAllConnections 切断现存连接。
    server.close();
    server.closeAllConnections();
  };

  return { stop };
}

/**
 * 创建 fluxion-vio 服务实例。
 *
 * 信号处理交给调用方：自行监听 SIGINT / SIGTERM，并在其中调用 controller.stop()。
 * @package Fluxion Vio
 * @version __VERSION__
 */
export async function fluxion(options: FluxionOptions): Promise<FluxionController> {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Invalid fluxion options: expected an object');
  }

  const alreadyNormalized = (options as NormalizedFluxionOptions).normalizedFlag === flags.OptionsNormalized;
  const normalized = alreadyNormalized ? (options as NormalizedFluxionOptions) : defineFluxionOptions(options);

  // 在任何日志之前重定向输出，这样启动失败（比如端口占用）也能落进文件。
  if (normalized.logOutputFile) {
    await redirectOutput(normalized.logOutputFile);
  }

  const logger = createLogger({ options: normalized });
  const moduleCache: ModuleCache = new Map();
  const router = createRouter({ options: normalized, logger, moduleCache });

  // 每个实例一个 AbortController。请求路径与它的 signal 赛跑，所以 stop 无需追踪具体请求就能作用于运行中的 handler。
  const lifecycle = new AbortController();

  // 缓存和路由都是实例级的：一次 fluxion() 加载的代码对另一次不可见。
  const context: FluxionContext = {
    options: normalized,
    logger,
    moduleCache,
    router,
    signal: lifecycle.signal,
    abort: () => lifecycle.abort(),
  };

  const server = await createServer(context);

  return createController(context, server);
}
