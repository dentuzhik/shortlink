import { renderRuntimeRoles, stateName } from "./lib/application-roles.mjs";
import { appKube } from "./lib/db-lab-connectivity.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const state = await appKube([
  "get",
  "configmap",
  stateName,
  "--ignore-not-found",
  "-o",
  "json",
]);
process.stdout.write(
  JSON.stringify(
    renderRuntimeRoles(
      JSON.parse(input),
      state.trim() ? JSON.parse(state) : null,
    ),
  ),
);
