export const codeTheme = {
  name: "roadmap-dark",
  type: "dark" as const,
  colors: {
    "editor.background": "#1d1d1f",
    "editor.foreground": "#f5f5f7",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#86868b", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage", "storage.type", "keyword.control", "constant.language"],
      settings: { foreground: "#2997ff" },
    },
    {
      scope: ["string", "string.quoted", "constant.numeric"],
      settings: { foreground: "#a1c9f7" },
    },
    {
      scope: ["entity.name.function", "entity.name.type", "entity.name.class", "support.function"],
      settings: { foreground: "#ffffff" },
    },
    {
      scope: ["variable.parameter", "punctuation", "meta.brace"],
      settings: { foreground: "#d2d2d7" },
    },
  ],
};
