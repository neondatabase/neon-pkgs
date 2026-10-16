import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { buildPoolConfig } from "./pg_pool_config.js";

const BASE = "postgresql://role:p%40ss@ep-1.neon.tech:5433/db1";
const dir = mkdtempSync(path.join(tmpdir(), "pool-config-"));
const caFile = path.join(dir, "root.crt");
writeFileSync(
	caFile,
	"-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildPoolConfig", () => {
	test("maps the connection parts and drops ssl params from the URL", () => {
		const config = buildPoolConfig(
			`${BASE}?sslmode=require&application_name=x`,
		);

		expect(config).toMatchObject({
			user: "role",
			password: "p@ss",
			host: "ep-1.neon.tech",
			port: 5433,
			database: "db1",
			application_name: "x",
		});
		expect(config).not.toHaveProperty("connectionString");
		expect(config).not.toHaveProperty("sslmode");
		expect(config).not.toHaveProperty("channel_binding");
	});

	test("leaves ssl unset when the URL has no sslmode", () => {
		expect(buildPoolConfig(BASE).ssl).toBeUndefined();
	});

	test.each([
		"require",
		"verify-ca",
		"verify-full",
		"prefer",
		"allow",
	])("sslmode=%s verifies the server certificate", (sslmode) => {
		const { ssl } = buildPoolConfig(`${BASE}?sslmode=${sslmode}`);
		expect(ssl).toMatchObject({ rejectUnauthorized: true });
		expect(ssl).not.toHaveProperty("checkServerIdentity");
	});

	test("sslmode=no-verify is the explicit opt-out", () => {
		expect(buildPoolConfig(`${BASE}?sslmode=no-verify`).ssl).toEqual({
			rejectUnauthorized: false,
		});
	});

	test("sslmode=disable turns TLS off", () => {
		expect(buildPoolConfig(`${BASE}?sslmode=disable`).ssl).toBe(false);
	});

	test("rejects an unknown sslmode instead of guessing", () => {
		expect(() => buildPoolConfig(`${BASE}?sslmode=bogus`)).toThrow(
			/Unsupported sslmode "bogus"/,
		);
	});

	test.each([
		"require",
		"verify-full",
	])("sslmode=%s reads sslrootcert as the trusted CA", (sslmode) => {
		const { ssl } = buildPoolConfig(
			`${BASE}?sslmode=${sslmode}&sslrootcert=${encodeURIComponent(caFile)}`,
		);
		expect(ssl).toMatchObject({
			rejectUnauthorized: true,
			ca: expect.stringContaining("BEGIN CERTIFICATE"),
		});
		expect(ssl).not.toHaveProperty("checkServerIdentity");
	});

	test("verify-ca with a pinned CA skips only the hostname check", () => {
		const { ssl } = buildPoolConfig(
			`${BASE}?sslmode=verify-ca&sslrootcert=${encodeURIComponent(caFile)}`,
		);
		expect(ssl).toMatchObject({
			rejectUnauthorized: true,
			ca: expect.any(String),
			checkServerIdentity: expect.any(Function),
		});
	});

	test("sslrootcert=system uses the default trust store", () => {
		const { ssl } = buildPoolConfig(
			`${BASE}?sslmode=verify-full&sslrootcert=system`,
		);
		expect(ssl).toEqual({ rejectUnauthorized: true });
	});

	test("fails loudly when sslrootcert is unreadable", () => {
		expect(() =>
			buildPoolConfig(
				`${BASE}?sslmode=verify-full&sslrootcert=${encodeURIComponent(path.join(dir, "missing.crt"))}`,
			),
		).toThrow(/ENOENT/);
	});

	test("channel_binding=require enables pg channel binding", () => {
		const config = buildPoolConfig(
			`${BASE}?sslmode=require&channel_binding=require`,
		);
		expect(config.enableChannelBinding).toBe(true);
		expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
	});

	test.each([
		"prefer",
		"disable",
	])("channel_binding=%s leaves it off", (value) => {
		expect(
			buildPoolConfig(`${BASE}?sslmode=require&channel_binding=${value}`)
				.enableChannelBinding,
		).toBeUndefined();
	});

	test.each([
		"?channel_binding=require",
		"?sslmode=disable&channel_binding=require",
	])("channel_binding=require without TLS is rejected (%s)", (query) => {
		expect(() => buildPoolConfig(`${BASE}${query}`)).toThrow(
			/channel_binding=require needs TLS/,
		);
	});

	test("rejects an unknown channel_binding value", () => {
		expect(() =>
			buildPoolConfig(`${BASE}?sslmode=require&channel_binding=maybe`),
		).toThrow(/Unsupported channel_binding "maybe"/);
	});
});
