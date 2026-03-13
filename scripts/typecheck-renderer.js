const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

function createDotnetEnv() {
  const userProfile = path.join(rootDir, ".user");

  return {
    ...process.env,
    DOTNET_CLI_HOME: path.join(rootDir, ".dotnet"),
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    NUGET_PACKAGES: path.join(rootDir, ".nuget", "packages"),
    USERPROFILE: userProfile,
    APPDATA: path.join(userProfile, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(userProfile, "AppData", "Local"),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: createDotnetEnv(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("dotnet", ["restore", "src/Renderer/Renderer.fsproj", "--configfile", "Nuget.Config"]);
run("dotnet", ["build", "src/Renderer/Renderer.fsproj", "--no-restore"]);
