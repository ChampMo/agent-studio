#!/usr/bin/env node
/**
 * Generate TypeScript types from events.schema.json.
 *
 * PROJECT_BRIEF.md §2.2: the schema is the ONE contract. Both sides are
 * generated from it; neither side is ever hand-written.
 *
 *   node generate.mjs           write the file
 *   node generate.mjs --check   exit 1 if the file on disk is stale or edited
 */
import { compile } from "json-schema-to-typescript";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const SCHEMA = resolve(ROOT, "packages/shared/events.schema.json");
const OUT = resolve(ROOT, "apps/desktop/src/transport/events.generated.ts");

const BANNER = `/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source:    packages/shared/events.schema.json
 * Regenerate: npm run codegen
 * Verify:     npm run codegen:check
 *
 * Editing this file by hand breaks the single-contract rule in
 * PROJECT_BRIEF.md §2.2, and codegen:check will fail in CI.
 */`;

const check = process.argv.includes("--check");

const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));

const generated = await compile(schema, "AgentStudioEvent", {
  bannerComment: BANNER,
  additionalProperties: false,
  unreachableDefinitions: true,
  declareExternallyReferenced: true,
  style: { singleQuote: false, semi: true },
});

if (check) {
  if (!existsSync(OUT)) {
    console.error(`codegen:check FAILED — ${OUT} does not exist. Run: npm run codegen`);
    process.exit(1);
  }
  const onDisk = readFileSync(OUT, "utf8");
  if (onDisk !== generated) {
    console.error(
      "codegen:check FAILED — apps/desktop/src/transport/events.generated.ts\n" +
        "  is out of sync with packages/shared/events.schema.json.\n" +
        "  Either the schema changed, or the generated file was hand-edited.\n" +
        "  Fix: npm run codegen"
    );
    process.exit(1);
  }
  console.log("codegen:check OK — TypeScript types match the schema.");
} else {
  writeFileSync(OUT, generated, "utf8");
  console.log(`wrote ${OUT}`);
}
