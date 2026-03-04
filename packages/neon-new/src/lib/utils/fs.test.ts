import { describe, expect, test } from "vitest";
import { splitCommands } from "./fs.js";

describe("splitCommands", () => {
	test("splits simple SQL statements", () => {
		const sql = `
      CREATE TABLE users (id SERIAL PRIMARY KEY);
      INSERT INTO users DEFAULT VALUES;
      SELECT * FROM users;
    `;

		const commands = splitCommands(sql);

		expect(commands).toHaveLength(3);
		expect(commands[0]).toContain("CREATE TABLE users");
		expect(commands[1]).toContain("INSERT INTO users");
		expect(commands[2]).toContain("SELECT * FROM users");
	});

	test("handles dollar-quoted strings in functions", () => {
		const sql = `
      CREATE TABLE test_table (id SERIAL PRIMARY KEY);

      CREATE FUNCTION test() 
      RETURNS void 
      LANGUAGE plpgsql 
      AS $$
      BEGIN
        SELECT 1;
      END;
      $$;

      INSERT INTO test_table DEFAULT VALUES;
    `;

		const commands = splitCommands(sql);

		expect(commands).toHaveLength(3);
		expect(commands[0]).toContain("CREATE TABLE test_table");
		expect(commands[1]).toContain("CREATE FUNCTION test()");
		expect(commands[1]).toContain("$$");
		expect(commands[2]).toContain("INSERT INTO test_table");
	});

	test("handles nested dollar quotes", () => {
		const sql = `
      CREATE FUNCTION complex_func() 
      RETURNS void 
      LANGUAGE plpgsql 
      AS $outer$
      BEGIN
        EXECUTE $inner$SELECT 1;$inner$;
      END;
      $outer$;
    `;

		const commands = splitCommands(sql);

		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("CREATE FUNCTION complex_func()");
		expect(commands[0]).toContain("$outer$");
		expect(commands[0]).toContain("$inner$");
	});

	test("handles SQL comments", () => {
		const sql = `
      -- This is a comment
      CREATE TABLE test (id INT);
      /* Multi-line
         comment */
      INSERT INTO test VALUES (1);
    `;

		const commands = splitCommands(sql);

		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain("CREATE TABLE test");
		expect(commands[1]).toContain("INSERT INTO test");
	});

	test("handles semicolons in string literals", () => {
		const sql = `
      INSERT INTO test VALUES ('value with ; semicolon');
      SELECT * FROM test WHERE val = 'another ; semicolon';
    `;

		const commands = splitCommands(sql);

		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain("value with ; semicolon");
		expect(commands[1]).toContain("another ; semicolon");
	});
});
