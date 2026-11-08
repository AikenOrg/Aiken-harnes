import {
  argbFromHex,
  hexFromArgb,
  themeFromSourceColor,
} from "@material/material-color-utilities";

const LIGHT_SURFACES: Record<string, string> = {
  surfaceDim: "#ded8e1",
  surfaceBright: "#fef7ff",
  surfaceContainerLowest: "#ffffff",
  surfaceContainerLow: "#f7f2fa",
  surfaceContainer: "#f3edf7",
  surfaceContainerHigh: "#ece6f0",
  surfaceContainerHighest: "#e6e0e9",
};

const DARK_SURFACES: Record<string, string> = {
  surfaceDim: "#141218",
  surfaceBright: "#3b383e",
  surfaceContainerLowest: "#0f0d13",
  surfaceContainerLow: "#1d1b20",
  surfaceContainer: "#211f26",
  surfaceContainerHigh: "#2b2930",
  surfaceContainerHighest: "#36343b",
};

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function schemeVars(scheme: Record<string, number>, surfaces: Record<string, string>): string[] {
  const vars: string[] = [];
  for (const [name, value] of Object.entries(scheme)) {
    if (typeof value !== "number") continue;
    vars.push(`  --md-sys-color-${kebab(name)}: ${hexFromArgb(value)};`);
  }
  for (const [name, value] of Object.entries(surfaces)) {
    vars.push(`  --md-sys-color-${kebab(name)}: ${value};`);
  }
  return [...new Set(vars)].sort();
}

function fallback(seed: string): { light: Record<string, number>; dark: Record<string, number> } {
  void seed;
  const light = themeFromSourceColor(argbFromHex("#6750A4"));
  return {
    light: light.schemes.light.toJSON() as Record<string, number>,
    dark: light.schemes.dark.toJSON() as Record<string, number>,
  };
}

/** シード色から M3 のカラーロールを生成する。壊れた色は既定色へフォールバックする。 */
export function createThemeCss(seedColor: string): string {
  let schemes: { light: Record<string, number>; dark: Record<string, number> };
  try {
    const theme = themeFromSourceColor(argbFromHex(seedColor));
    schemes = {
      light: theme.schemes.light.toJSON() as Record<string, number>,
      dark: theme.schemes.dark.toJSON() as Record<string, number>,
    };
  } catch {
    schemes = fallback(seedColor);
  }
  const light = schemeVars(schemes.light, LIGHT_SURFACES);
  const dark = schemeVars(schemes.dark, DARK_SURFACES);
  return [
    ":root {",
    "  color-scheme: light dark;",
    ...light.map((line) => `  ${line}`),
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    ...dark.map((line) => `    ${line}`),
    "  }",
    "}",
    "",
    ":root {",
    "  --ui-seed: " + seedColor + ";",
    "}",
    "",
  ].join("\n");
}
