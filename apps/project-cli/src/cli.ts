import { runProjectCommand } from "./project-command";

process.exitCode = await runProjectCommand(process.argv.slice(2));
