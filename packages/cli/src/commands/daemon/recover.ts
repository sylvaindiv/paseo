import { Command } from "commander";
import { managedDaemonCommand } from "@getpaseo/server/daemon-control";
import { addLocalDaemonOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions } from "../../output/index.js";

export function daemonRecoverCommand(): Command {
  return addLocalDaemonOptions(
    new Command("recover").description("Recover a verified local desktop daemon"),
  ).action(
    withOutput(async (options: CommandOptions, _command: Command) => {
      if (options.daemonTarget.kind !== "instance")
        throw new Error("Recovery requires a local home");
      const recovery = await managedDaemonCommand(options.daemonTarget.home, "recover");
      return {
        type: "single" as const,
        data: { action: "recovered", recovery },
        schema: {
          idField: "action" as const,
          columns: [],
          renderHuman: () => "Connexion rétablie",
        },
      };
    }),
  );
}
