import path from "node:path";
import { verifyWebArtifacts } from "./lib/web-artifact-verifier.js";

const result = await verifyWebArtifacts({
  mainDir: path.resolve("dist-main"),
  aiDir: path.resolve("dist-ai")
});

process.stdout.write(
  `web artifacts isolated (${result.mainFilesChecked} main files, ${result.aiFilesChecked} AI files)\n`
);
