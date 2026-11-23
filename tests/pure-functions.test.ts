import { describe, expect, it } from 'vitest';

import { parseQuery } from '@/http/query.js';
import { parseCookie } from '@/http/cookie.js';
import { formatError } from '@/common/logger.js';
import { ModuleRejection, selectModule } from '@/common/injector.js';
import { ModuleType } from '@/common/consts.js';
import { defineFluxionModule } from '@/defines/index.js';

const apiModule = defineFluxionModule(() => ({ ok: true }));

describe('parseQuery（纯函数）', () => {
  it('单个键保持字符串', () => {
    expect(parseQuery(new URLSearchParams('a=1&b=2'))).toEqual({ a: '1', b: '2' });
  });

  it('重复键按首次出现顺序变成数组', () => {
    expect(parseQuery(new URLSearchParams('a=1&a=2&b=x&a=3'))).toEqual({ a: ['1', '2', '3'], b: 'x' });
  });

  it('空查询返回空对象', () => {
    expect(parseQuery(new URLSearchParams(''))).toEqual({});
  });

  it('不改动传入的 URLSearchParams', () => {
    const params = new URLSearchParams('a=1&a=2');
    const before = params.toString();
    parseQuery(params);
    expect(params.toString()).toBe(before);
  });

  it('两次调用互不影响（无隐藏状态）', () => {
    const params = new URLSearchParams('a=1');
    expect(parseQuery(params)).toEqual({ a: '1' });
    expect(parseQuery(params)).toEqual({ a: '1' });
  });
});

describe('parseCookie（纯函数）', () => {
  it('解析常规 cookie', () => {
    expect(parseCookie('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('值里允许出现 =', () => {
    expect(parseCookie('token=abc==')).toEqual({ token: 'abc==' });
  });

  it('解码百分号编码', () => {
    expect(parseCookie('name=hello%20world')).toEqual({ name: 'hello world' });
  });

  it('非法编码原样保留，不抛错', () => {
    expect(parseCookie('bad=%E0%A4%A')).toEqual({ bad: '%E0%A4%A' });
  });

  it('忽略空片段与空键', () => {
    expect(parseCookie(' ; =x; a=1')).toEqual({ a: '1' });
  });

  it('缺少头部时返回空对象', () => {
    expect(parseCookie(undefined)).toEqual({});
    expect(parseCookie('')).toEqual({});
  });

  it('最多解析 100 个键', () => {
    const header = Array.from({ length: 150 }, (_, i) => `k${i}=v`).join('; ');
    expect(Object.keys(parseCookie(header))).toHaveLength(100);
  });
});

describe('selectModule（纯校验）', () => {
  it('合法的 defineFluxionModule 结果被选中', () => {
    expect(selectModule({ default: apiModule }).module).toBe(apiModule);
  });

  it('优先取 default 导出', () => {
    const other = defineFluxionModule(() => ({ ok: 'other' }));
    expect(selectModule({ default: apiModule, named: other }).module).toBe(apiModule);
  });

  it('没有可用的 default 时退回 exports 本身', () => {
    expect(selectModule(apiModule).module).toBe(apiModule);
  });

  it('非对象导出被拒绝', () => {
    expect(selectModule(undefined).rejection).toBe(ModuleRejection.MustUseDefineFluxionModule);
    expect(selectModule(null).rejection).toBe(ModuleRejection.MustUseDefineFluxionModule);
    expect(selectModule('x').rejection).toBe(ModuleRejection.MustUseDefineFluxionModule);
  });

  it('缺少 handler 被拒绝', () => {
    expect(selectModule({ default: { type: ModuleType.Api } }).rejection).toBe(
      ModuleRejection.HandlerMustBeFunction,
    );
  });

  it('disposer 类型错误被拒绝', () => {
    expect(selectModule({ default: { handler: () => {}, type: ModuleType.Api, disposer: 1 } }).rejection).toBe(
      ModuleRejection.DisposerMustBeFunctionIfProvided,
    );
  });

  it('handlerTimeoutMs 过小或非整数被拒绝', () => {
    const withTimeout = (handlerTimeoutMs: number) =>
      selectModule({ default: { handler: () => {}, type: ModuleType.Api, handlerTimeoutMs } }).rejection;
    expect(withTimeout(99)).toBe(ModuleRejection.HandlerTimeoutMsMustBeInteger);
    expect(withTimeout(100.5)).toBe(ModuleRejection.HandlerTimeoutMsMustBeInteger);
    expect(withTimeout(100)).toBeUndefined();
  });

  it('没有 defineFluxionModule 标记（type 错误）被拒绝', () => {
    expect(selectModule({ default: { handler: () => {} } }).rejection).toBe(
      ModuleRejection.MustUseDefineFluxionModule,
    );
  });

  it('两个候选都不可用时报告 default 的缺陷', () => {
    const exports = { default: { handler: 'nope' }, other: 1 };
    expect(selectModule(exports).module).toBeUndefined();
    expect(selectModule(exports).rejection).toBe(ModuleRejection.HandlerMustBeFunction);
  });

  it('校验过程不修改入参', () => {
    const raw = { handler: () => {}, type: ModuleType.Api };
    const keys = Object.keys(raw).sort();
    selectModule({ default: raw });
    expect(Object.keys(raw).sort()).toEqual(keys);
    expect(raw).not.toHaveProperty('absolutePath');
  });
});

describe('formatError（纯函数）', () => {
  it('展开 message 与 stack', () => {
    const err = new Error('boom');
    err.stack = 'stack-line';
    expect(formatError(err)).toBe('boom\nstack-line');
  });

  it('只有 message 时不追加换行', () => {
    const err = new Error('boom');
    err.stack = undefined;
    expect(formatError(err)).toBe('boom');
  });

  it('原始值转成字符串', () => {
    expect(formatError('oops')).toBe('oops');
    expect(formatError(42)).toBe('42');
    expect(formatError(undefined)).toBe('undefined');
  });
});
