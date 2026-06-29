import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Analytics, TrackParams } from '@segment/analytics-node';
import { isAxiosError } from 'axios';

import { CREDENTIALS_FILE } from './config.js';
import { isCurrentBranchProbe } from './context.js';
import { getGithubEnvVars, isCi } from './env.js';
import { ErrorCode } from './errors.js';
import { log } from './log.js';
import pkg from './pkg.js';
import { getApiClient } from './api.js';

const WRITE_KEY = '3SQXn5ejjXWLEJ8xU2PRYhAotLtTaeeV';

/**
 * Raw-argv fallback for the offline `--current-branch` probe. The init
 * middleware runs before validation, where the parsed `currentBranch` flag may
 * not be populated yet, so we also scan `process.argv` directly to be safe.
 */
const hasCurrentBranchArgv = (): boolean =>
  process.argv.includes('--current-branch');

let client: Analytics | undefined;
let clientInitialized = false;
let userId = '';

/**
 * Phase 1: Run before validation so the Segment client exists if any
 * middleware (e.g. auth) fails. Enables sendError() in the fail handler.
 * Does not resolve user id or send CLI Started.
 */
export const initAnalyticsClientMiddleware = (args: {
  analytics: boolean;
  [key: string]: unknown;
}) => {
  if (!args.analytics || clientInitialized) {
    return;
  }
  // The offline `--current-branch` probe must make zero network calls. This
  // middleware runs before validation, so guard on the raw argv too (in case
  // the parsed `currentBranch` flag isn't populated this early): never create
  // the Segment client, which keeps trackEvent/closeAnalytics no-ops downstream.
  if (isCurrentBranchProbe(args as any) || hasCurrentBranchArgv()) {
    return;
  }
  clientInitialized = true;
  client = new Analytics({
    writeKey: WRITE_KEY,
    host: 'https://track.neon.tech',
  });
  log.debug('Initialized CLI analytics client');
  client.identify({
    userId: 'anonymous',
  });
};

/**
 * Phase 2: Run after auth. Resolves user id from credentials,
 * identifies the user, and sends CLI Started.
 */
export const analyticsMiddleware = async (args: {
  analytics: boolean;
  apiKey?: string;
  apiHost?: string;
  configDir: string;
  _: (string | number)[];
  [key: string]: unknown;
}) => {
  if (!client || !args.analytics) {
    return;
  }
  if (isCurrentBranchProbe(args)) {
    return;
  }

  try {
    const credentialsPath = join(args.configDir, CREDENTIALS_FILE);
    const credentials = readFileSync(credentialsPath, { encoding: 'utf-8' });
    userId = JSON.parse(credentials).user_id;
  } catch (err) {
    log.debug('Failed to read credentials file', err);
  }

  try {
    if (args.apiKey) {
      const apiClient = getApiClient({
        apiKey: args.apiKey,
        apiHost: args.apiHost,
      });

      // Populating api key details for analytics
      const authDetailsResponse = await apiClient.getAuthDetails();
      const authDetails = authDetailsResponse.data;
      args.accountId = authDetails.account_id;
      args.authMethod = authDetails.auth_method;
      args.authData = authDetails.auth_data;

      // Get user id if not org api key
      if (!userId && authDetails.auth_method !== 'api_key_org') {
        const resp = await apiClient?.getCurrentUserInfo?.();
        userId = resp?.data?.id;
      }
    } else {
      args.accountId = userId;
      args.authMethod = 'oauth';
    }
  } catch (err) {
    log.debug('Failed to get user id from api', err);
  }

  client.identify({
    userId: userId?.toString() ?? 'anonymous',
  });

  client.track({
    userId: userId || 'anonymous',
    event: 'CLI Started',
    properties: getAnalyticsEventProperties(args),
    context: {
      direct: true,
    },
  });
};

export const closeAnalytics = async (opts?: { timeout?: number }) => {
  if (client) {
    log.debug('Flushing CLI analytics');
    // `timeout` bounds how long we wait for in-flight events to flush so a
    // slow / unreachable track.neon.tech can't hang a short-lived command
    // (e.g. the psql launch path, which flushes here before process.exit).
    await client.closeAndFlush(opts);
    log.debug('Flushed CLI analytics');
  }
};

export const sendError = (err: Error, errCode: ErrorCode) => {
  if (!client) {
    return;
  }
  const axiosError = isAxiosError(err) ? err : undefined;
  const requestId = axiosError?.response?.headers['x-neon-ret-request-id'];
  if (requestId) {
    log.debug('Failed request ID: %s', requestId);
  }
  client.track({
    event: 'CLI Error',
    userId: userId || 'anonymous',
    properties: {
      message: err.message,
      stack: err.stack,
      errCode,
      statusCode: axiosError?.response?.status,
      requestId: requestId,
    },
  });
  log.debug('Sent CLI error event: %s', errCode);
};

export const trackEvent = (
  event: string,
  properties: TrackParams['properties'],
) => {
  if (!client) {
    return;
  }
  client.track({
    event,
    userId: userId || 'anonymous',
    properties,
  });
  log.debug('Sent CLI event: %s', event);
};

export const getAnalyticsEventProperties = (args: any) => ({
  version: pkg.version,
  command: args._.join(' '),
  flags: {
    output: args.output,
  },
  ci: isCi(),
  githubEnvVars: getGithubEnvVars(process.env),
});
