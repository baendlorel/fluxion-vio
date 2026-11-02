import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redirectOutput } from '../src/common/output.js';

const stdoutWrite = process.stdout.write;
const stderrWrite = process.stderr.write;

afterEach(() => {
  process.stdout.write = stdoutWrite;
  process.stderr.write = stderrWrite;
});

const makeFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fluxion-output-')), 'server.log');

describe('redirectOutput', () => {
  test('sends stdout and stderr writes to the file', async () => {
    const file = makeFile();
    await redirectOutput(file);

    process.stdout.write('via stdout\n');
    process.stderr.write('via stderr\n');

    expect(fs.readFileSync(file, 'utf8')).toBe('via stdout\nvia stderr\n');
  });

  test('appends to an existing file', async () => {
    const file = makeFile();
    fs.writeFileSync(file, 'earlier\n');
    await redirectOutput(file);

    process.stdout.write('later\n');

    expect(fs.readFileSync(file, 'utf8')).toBe('earlier\nlater\n');
  });

  test('calls the write callback', async () => {
    await redirectOutput(makeFile());

    await new Promise<void>((resolve) => process.stdout.write('x', () => resolve()));
  });

  test('rejects when the file cannot be opened', async () => {
    const dir = path.dirname(makeFile());
    await expect(redirectOutput(dir)).rejects.toBeInstanceOf(Error);
  });
});
