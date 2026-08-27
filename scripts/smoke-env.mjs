const SAFE_LOCALE = /^(?:[A-Za-z_][A-Za-z0-9_.-]*)(?:\.[A-Za-z0-9-]+)?$/;

/** Builds the complete smoke-child environment. It deliberately never reads or merges process.env. */
export function packageSmokeEnvironment(home, nodePath, locale = "C") {
  if (!SAFE_LOCALE.test(locale))
    throw new Error("Invalid package smoke locale");
  const environment = {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    ELECTRON_RUN_AS_NODE: "1",
  };
  if (nodePath !== undefined) environment.NODE_PATH = nodePath;
  environment.LANG = locale;
  environment.LC_ALL = locale;
  return environment;
}
