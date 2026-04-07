import { describe, it, expect, vi } from 'vitest';

// We test the parsing logic by importing the module and mocking execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { getOutdatedPackages } from '../../src/upgrade/outdated.js';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function setupMock(stdout: string, exitCode: number = 0) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
    if (exitCode !== 0 && !stdout) {
      callback(new Error(`exit code ${exitCode}`), '', '');
    } else {
      const err = exitCode !== 0 ? new Error(`exit code ${exitCode}`) : null;
      callback(err, stdout, '');
    }
    return {} as any;
  });
}

describe('getOutdatedPackages', () => {
  it('parses npm outdated JSON output', async () => {
    const npmOutput = JSON.stringify({
      lodash: {
        current: '4.17.20',
        wanted: '4.17.21',
        latest: '4.17.21',
        type: 'dependencies',
        location: 'node_modules/lodash',
      },
      typescript: {
        current: '4.9.0',
        wanted: '4.9.5',
        latest: '5.0.0',
        type: 'devDependencies',
        location: 'node_modules/typescript',
      },
    });
    setupMock(npmOutput, 1); // npm outdated exits 1 when there are outdated packages

    const result = await getOutdatedPackages('/project', 'npm');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('lodash');
    expect(result[0].current).toBe('4.17.20');
    expect(result[0].latest).toBe('4.17.21');
    expect(result[0].type).toBe('dependencies');
    expect(result[1].name).toBe('typescript');
    expect(result[1].type).toBe('devDependencies');
  });

  it('parses pnpm outdated JSON output', async () => {
    const pnpmOutput = JSON.stringify([
      {
        packageName: 'zod',
        current: '3.22.0',
        wanted: '3.22.4',
        latest: '4.0.0',
        dependencyType: 'dependencies',
      },
    ]);
    setupMock(pnpmOutput);

    const result = await getOutdatedPackages('/project', 'pnpm');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('zod');
    expect(result[0].current).toBe('3.22.0');
    expect(result[0].latest).toBe('4.0.0');
  });

  it('parses yarn outdated JSON output', async () => {
    const yarnOutput = JSON.stringify({
      type: 'table',
      data: {
        body: [
          ['react', '17.0.2', '17.0.2', '18.2.0', 'dependencies', 'https://reactjs.org'],
        ],
      },
    });
    setupMock(yarnOutput);

    const result = await getOutdatedPackages('/project', 'yarn');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('react');
    expect(result[0].current).toBe('17.0.2');
    expect(result[0].latest).toBe('18.2.0');
  });

  it('returns empty array when no outdated packages', async () => {
    setupMock('');

    const result = await getOutdatedPackages('/project', 'npm');
    expect(result).toEqual([]);
  });

  it('rejects when command fails with no output', async () => {
    setupMock('', 1);

    await expect(getOutdatedPackages('/project', 'npm')).rejects.toThrow(
      'Failed to run npm outdated',
    );
  });
});
