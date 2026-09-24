/* Pulls named declarations out of index.html's source so the page stays the single source of truth for its encoders,
 * pinned constants and route validators. Shared by ../test.mjs and the headless bot.
 */

export function extractor(HTML) {
  /* brace matching runs on a copy with string literals and comments blanked (same length, so indexes
     line up), because a lone "{" inside a string would otherwise run the extraction to the end of the file */
  const MASK = HTML.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, s => " ".repeat(s.length));
  function extractFrom(startRe, name) {
    const m = startRe.exec(HTML);
    if (!m) throw new Error(`cannot find ${name} in index.html`);
    // skip the parameter list first: a default parameter like `out = {}` would otherwise
    // end the brace matching inside the signature
    let start = m.index;
    const paren = MASK.indexOf("(", m.index);
    if (paren >= 0 && paren < MASK.indexOf("{", m.index)) {
      let pd = 0, i = paren;
      for (; i < MASK.length; i++) { if (MASK[i] === "(") pd++; else if (MASK[i] === ")") { pd--; if (!pd) break; } }
      start = i;
    }
    let k = MASK.indexOf("{", start), depth = 0;
    while (k < MASK.length) {
      if (MASK[k] === "{") depth++;
      else if (MASK[k] === "}") { depth--; if (!depth) break; }
      k++;
    }
    if (depth) throw new Error(`unbalanced braces extracting ${name}`);
    return HTML.slice(m.index, k + 1) + (HTML[k + 1] === ";" ? ";" : "");
  }
  const fn = name => extractFrom(new RegExp("(?:async +)?function " + name + " *\\("), name);
  const arrow = name => { const m = new RegExp(`^const ${name}\\s*=`, "m").exec(HTML); if (!m) throw new Error(`cannot find const ${name}`); return HTML.slice(m.index, HTML.indexOf("\n", m.index) + 1); };
  return { extractFrom, fn, arrow };
}
