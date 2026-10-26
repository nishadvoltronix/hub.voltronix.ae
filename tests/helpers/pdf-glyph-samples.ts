/** Synthetic coverage samples, never imported as customer or product data. */
export const pdfGlyphSamples = {
  latin: "Caf\u00e9 Soci\u00e9t\u00e9 \u2014 \u0141\u00f3d\u017a",
  greek: "\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac \u03a9\u03bc\u03ad\u03b3\u03b1",
  cyrillic: "\u041a\u0430\u0431\u0435\u043b\u044c \u041c\u043e\u0441\u043a\u0432\u0430",
  engineering: "230 V \u00b1 5% / 50 Hz / 25 \u00b0C / 10 mm\u00b2 / 2 \u00d7 4 / \u03a9 \u00b5 \u03bc / \u20ac \u00a3 \u20b9",
  decomposed: "Cafe\u0301",
} as const;

export const unsupportedPdfGlyphSamples = {
  arabic: "\u0645\u0631\u062d\u0628\u0627",
  hebrew: "\u05e9\u05dc\u05d5\u05dd",
  devanagari: "\u0928\u092e\u0938\u094d\u0924\u0947",
  chinese: "\u4f60\u597d",
  emoji: "\ud83d\ude42",
  directionOverride: "test\u202Ehidden",
  directionIsolate: "test\u2066hidden\u2069",
  zeroWidthJoiner: "test\u200Dhidden",
} as const;
