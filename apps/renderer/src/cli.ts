import { runVideoCommand } from "./video-command";

process.exitCode = await runVideoCommand(process.argv.slice(2));
