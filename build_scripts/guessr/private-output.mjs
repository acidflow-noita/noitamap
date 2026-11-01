import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Question SQL and seeds must never enter a public build or Git checkout. */
export function privateOutput(path) {
  const output = resolve(path),
    inside = relative(repository, output);
  if (
    !isAbsolute(inside) &&
    !inside.startsWith("..") &&
    !inside.startsWith("task/guessr/private/")
  ) {
    throw new Error(
      "Keep private packs outside the repository or under ignored task/guessr/private/.",
    );
  }
  return output;
}
