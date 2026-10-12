import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

// Exercise the real helper and both writers without launching a CLI. The
// in-memory filesystem exposes the truncate/write window deterministically.
const source = readFileSync(new URL("fake-acp-cli.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("fake-acp-cli.ts", source, ts.ScriptTarget.Latest, true);
const writes: string[] = [];
let helper = "";
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "writeDumpAtomic") {
    helper = `const ${node.getText(ast)};`;
  }
  if (ts.isCallExpression(node) && node.arguments[0]?.getText(ast) === "process.env.FAKE_ACP_DUMP") {
    writes.push(node.getText(ast));
  }
  ts.forEachChild(node, visit);
};
visit(ast);

function fixture(renameFailures = 0, code = "EPERM") {
  const old = JSON.stringify({ pid: 1, env: { TEST_KEY: "old" } });
  const next = { pid: 2, env: { TEST_KEY: "new" }, mcpServers: [] };
  const files = new Map([["capture.json", old]]);
  const duringWrite: string[] = [];
  const delays: number[] = [];
  let attempts = 0;
  const failure = Object.assign(new Error("rename failed"), { code });
  const context = {
    process: { pid: 2, env: { FAKE_ACP_DUMP: "capture.json" } },
    dumpState: next,
    writeFileSync(path: string, contents: string) {
      files.set(path, "");
      duringWrite.push(files.get("capture.json")!);
      files.set(path, contents);
    },
    renameSync(from: string, to: string) {
      attempts += 1;
      if (attempts <= renameFailures) throw failure;
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    unlinkSync(path: string) { files.delete(path); },
    Atomics: { wait(_array: unknown, _index: number, _value: number, delay: number) { delays.push(delay); } },
  };
  return {
    old, next, files, duringWrite, delays, failure, attempts: () => attempts,
    run(index: number) {
      expect(writes).toHaveLength(2);
      const code = ts.transpileModule(`${helper}\n${writes[index]};`, {
        compilerOptions: { target: ts.ScriptTarget.ESNext },
      }).outputText;
      runInNewContext(code, context);
    },
  };
}

it.each([0, 1])("whole-document writer %i keeps a complete capture visible during replacement", (index) => {
  const f = fixture();
  f.run(index);
  expect(f.duringWrite).toEqual([f.old]);
  expect(JSON.parse(f.files.get("capture.json")!)).toEqual(f.next);
  expect([...f.files.keys()]).toEqual(["capture.json"]);
});

it("retries only a temporarily held rename, without writing the capture again", () => {
  const f = fixture(2);
  f.run(0);
  expect(f.delays).toEqual([5, 10]);
  expect(f.duringWrite).toEqual([f.old]);
  expect(JSON.parse(f.files.get("capture.json")!)).toEqual(f.next);
  expect([...f.files.keys()]).toEqual(["capture.json"]);
});

it.each(["EPERM", "EINVAL"])("preserves the capture and removes staging on unrecoverable %s", (code) => {
  const f = fixture(Infinity, code);
  expect(() => f.run(1)).toThrow(f.failure);
  expect(f.attempts()).toBe(code === "EPERM" ? 6 : 1);
  expect(f.delays).toEqual(code === "EPERM" ? [5, 10, 20, 40, 80] : []);
  expect([...f.files]).toEqual([["capture.json", f.old]]);
});
