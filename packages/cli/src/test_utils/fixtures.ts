import { createServer, Server } from 'node:http';
import { fork } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test as originalTest } from 'vitest';
import strip from 'strip-ansi';
import emocks from 'emocks';
import express from 'express';

import { log } from '../log';

type Fixtures = {
  runMockServer: (mockDir: string) => Promise<Server>;
  testCliCommand: (
    args: string[],
    options?: {
      mockDir?: string;
      stderr?: string;
      code?: number;
      outputTable?: boolean;
      output?: 'json' | 'yaml' | 'table';
      env?: Record<string, string>;
      /**
       * Point the CLI at a port that is bound and then immediately released, so the
       * request fails with a genuine connection error (ECONNREFUSED) instead of a slow
       * DNS timeout. Used to exercise the CLI's network-error handling end to end without
       * a mock server in the loop.
       */
      unreachableHost?: boolean;
    },
  ) => Promise<void>;
};

/**
 * Reserve a localhost port and close its listener, returning a URL that is guaranteed to
 * refuse connections right now. Lets a test drive the CLI into a real `ECONNREFUSED`
 * (the same shape a network blip produces) deterministically and fast.
 */
const reserveClosedPort = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(`http://127.0.0.1:${port}`);
        }
      });
    });
  });

export const test = originalTest.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  runMockServer: async ({}, use) => {
    let startedServer: Server | undefined;
    await use(async (mockDir) => {
      const app = express();
      app.use(express.json());
      app.use(
        '/',
        emocks(join(process.cwd(), 'mocks', mockDir), {
          '404': (_req, res) => res.status(404).send({ message: 'Not Found' }),
        }),
      );

      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => {
          log.debug(
            'Mock server listening at %d',
            (s.address() as AddressInfo).port,
          );
          resolve(s);
        });
      });
      startedServer = server;
      return server;
    });
    // `unreachableHost` tests never start the server, so only close it when it ran.
    const server = startedServer;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          } else {
            resolve();
          }
        });
      });
    }
  },
  testCliCommand: async ({ runMockServer }, use) => {
    await use(async (args, options = {}) => {
      const apiHost = options.unreachableHost
        ? await reserveClosedPort()
        : `http://localhost:${
            (
              (
                await runMockServer(options.mockDir || 'main')
              ).address() as AddressInfo
            ).port
          }`;
      let output = '';
      let error = '';

      const cp = fork(
        join(process.cwd(), './dist/index.js'),
        [
          '--api-host',
          apiHost,
          '--output',
          options.output ?? (options.outputTable ? 'table' : 'yaml'),
          '--api-key',
          'test-key',
          '--no-analytics',
          ...args,
        ],
        {
          stdio: 'pipe',
          env: {
            PATH: `mocks/bin:${process.env.PATH}`,
            ...(options.env ?? {}),
          },
        },
      );

      return new Promise<void>((resolve, reject) => {
        cp.stdout?.on('data', (data: Buffer) => {
          output += data.toString();
        });

        cp.stderr?.on('data', (data: Buffer) => {
          error += data.toString();
          log.error(data.toString());
        });

        cp.on('error', (err) => {
          log.error(err);
          throw err;
        });

        cp.on('close', (code) => {
          try {
            expect(code).toBe(options?.code ?? 0);
            expect(output).toMatchSnapshot();
            if (options.stderr !== undefined) {
              expect(strip(error).replace(/\s+/g, ' ').trim()).toEqual(
                typeof options.stderr === 'string'
                  ? options.stderr.toString().replace(/\s+/g, ' ')
                  : options.stderr,
              );
            }
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }).catch((err: unknown) => {
        log.error(err);
        throw err;
      });
    });
  },
});
