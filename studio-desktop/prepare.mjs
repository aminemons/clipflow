import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const sdkVersion = "0a36fefeb913055c8c7a1a29b63d82b96b2e841a";
const root = import.meta.dirname;
const frontend = join(root, "../frontend");
const build = join(root, ".build");
const sdk = join(build, "siwc-devkit");
const app = join(build, "app");
function call(command, args, cwd) {
  if (process.platform === "win32" && command === "npm") {
    // All npm arguments below are fixed build commands.
    execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd, stdio: "inherit" });
  } else execFileSync(command, args, { cwd, stdio: "inherit" });
}
mkdirSync(build, { recursive: true });
if (!existsSync(join(sdk, ".git"))) call("git", ["clone", "--no-checkout", "https://github.com/openai/sign-in-with-chatgpt-devkit.git", "siwc-devkit"], build);
call("git", ["checkout", "--detach", sdkVersion], sdk);
call("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], sdk);
call("npm", ["run", "build", "-w", "@siwc/local"], sdk);
if (!existsSync(join(frontend, "node_modules", "vite"))) call("npm", ["ci", "--no-audit", "--no-fund"], frontend);
call("npm", ["run", "build"], frontend);

rmSync(app, { recursive: true, force: true });
const local = join(app, "node_modules", "@siwc", "local");
mkdirSync(local, { recursive: true });
cpSync(join(frontend, "dist"), join(app, "renderer"), { recursive: true });
cpSync(join(frontend, "shared"), join(app, "shared"), { recursive: true });
for (const file of ["main.mjs", "preload.cjs", "WINDOWS-README.txt"]) cpSync(join(root, file), join(app, file));
cpSync(join(root, "../LICENSE"), join(app, "LICENSE-Clipflow"));
cpSync(join(sdk, "packages/local/dist"), join(local, "dist"), { recursive: true });
cpSync(join(sdk, "packages/local/package.json"), join(local, "package.json"));

const sdkRequire = createRequire(join(sdk, "packages/local/package.json"));
const versions = {};
function include(name, resolver) {
  if (versions[name]) return;
  const location = resolver.resolve.paths(name).find(path => existsSync(join(path, name, "package.json")));
  if (!location) throw new Error(`Could not locate runtime package ${name}.`);
  const directory = join(location, name);
  const metadata = join(directory, "package.json");
  const info = JSON.parse(readFileSync(metadata, "utf8"));
  versions[name] = info.version;
  cpSync(directory, join(app, "node_modules", name), { recursive: true });
  const childResolver = createRequire(metadata);
  for (const child of Object.keys(info.dependencies ?? {})) include(child, childResolver);
}
for (const name of ["jose", "openai", "proper-lockfile"]) include(name, sdkRequire);
writeFileSync(join(app, "package.json"), JSON.stringify({
  name: "clipflow-studio", productName: "Clipflow Studio", version: "1.0.0", type: "module",
  main: "main.mjs", description: "Local-first short video editing studio",
  dependencies: { ...versions, "@siwc/local": "0.1.0" },
}, null, 2));
