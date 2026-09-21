import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateFixture } from "./fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../fixtures/default.json");
writeFileSync(out, JSON.stringify(generateFixture(), null, 2) + "\n");
console.log(`fixture written: ${out}`);
