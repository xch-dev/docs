Prism.languages.rue = {
  function: {
    pattern: /\b(fn)\s+[a-zA-Z_][a-zA-Z0-9_]*/,
    lookbehind: true,
  },
  "function-call": {
    pattern: /\b[a-zA-Z_][a-zA-Z0-9_]*\s*(?:::|\()/,
    alias: "function",
  },
  field: {
    pattern: /(?!\b(?:let|const))\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*:)/,
    alias: "property",
  },
  "field-access": {
    pattern: /\b(\.)([a-zA-Z_][a-zA-Z0-9_]*)/,
    lookbehind: true,
    alias: "property",
  },
  string: {
    pattern: /"[^"]*"/,
  },
  comment: {
    pattern: /\/\/.*|\/\*[^]*?\*\//,
    multiline: true,
    greedy: true,
  },
  number: /\b(?:0[xX][0-9a-fA-F_]+|[0-9][0-9_]*)\b/,
  operator:
    /[+\-*?%!\^~]|<[<=]?|>[>=]?|=[=>]?|!=?|\.(?:\.\.)?|::|->?|&&?|\|\|?/,
  punctuation: /[(){}[\],:]/,
  "control-flow": {
    pattern: /\b(?:if|else|return|raise|assert)\b/,
    alias: "keyword",
  },
  binding: {
    pattern: /\b(?:let|const|fn)\b/,
    alias: "keyword",
  },
  type: {
    pattern: /\b(?:type|struct|as|is)\b/,
    alias: "keyword",
  },
  module: {
    pattern: /\b(?:import|mod)\b/,
    alias: "keyword",
  },
  modifier: { pattern: /\b(?:inline|export|extern|test)\b/, alias: "keyword" },
  boolean: /\b(?:false|true)\b/,
  null: {
    pattern: /\bnil\b/,
    alias: "constant",
  },
  builtin:
    /\b(?:Atom|Bytes|Bytes32|PublicKey|Signature|K1PublicKey|K1Signature|R1PublicKey|R1Signature|Int|Bool|Any|List|AlternatingList)\b/,
  "class-name": /\b[A-Z][a-z][a-zA-Z0-9_]*\b/,
  constant: /\b[A-Z][A-Z0-9_]*\b/,
};
