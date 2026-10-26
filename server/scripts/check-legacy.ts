import { runLegacyInspection } from "./legacy-compat/command.js";

// Explicit offline operator entrypoint: never import the application entrypoint,
// load dotenv, establish a connection, execute SQL or enable runtime writes.
const result = runLegacyInspection(process.argv.slice(2));
console.log(JSON.stringify(result.output, null, 2));
process.exitCode = result.exitCode;
