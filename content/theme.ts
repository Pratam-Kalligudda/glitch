/** Code colours for the black code card: crystal cyan and mint on paper white. */
export const codeTheme = {
  name: "glitch",
  type: "dark" as const,
  colors: {
    "editor.background": "#0b0b0b",
    "editor.foreground": "#f2f2f0",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#8a8a8a", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage", "storage.type", "keyword.control", "constant.language"],
      settings: { foreground: "#3ee0ff" },
    },
    {
      scope: ["string", "string.quoted", "constant.numeric"],
      settings: { foreground: "#4fe9a4" },
    },
    {
      scope: ["entity.name.function", "entity.name.type", "entity.name.class", "support.function"],
      settings: { foreground: "#ffffff" },
    },
    {
      scope: ["variable.parameter", "punctuation", "meta.brace"],
      settings: { foreground: "#d6d6d6" },
    },
  ],
};
