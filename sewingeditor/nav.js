// Shared top nav: one link per page in sewingeditor/, inserted as the first
// child of #container. Every page loads this with a plain <script> tag, so a
// new page only needs adding to PAGES below. Links resolve against this
// file's own URL, so they work from any subfolder.
(function () {
  const PAGES = [
    ["index.html", "sewing editor"],
    ["gcode-session/gcode-session.html", "printing session"],
    ["texture-actions/texture-actions.html", "textures"],
    ["brush-sketch/brush-sketch.html", "brush sketch"],
    ["sketch-studio/sketch-studio.html", "sketch studio"],
    ["parametric/parametric.html", "parametric tactile graphics"],
    ["parametric-on-client/parametric-on-client.html", "parametric (client-side LLM)"],
    ["parametric-with-tool/parametric-with-tool.html", "parametric (staged pipeline)"],
  ];
  const base = new URL(".", document.currentScript.src);
  const here = location.pathname;

  const nav = document.createElement("div");
  nav.className = "ui-group";
  nav.style.cssText = "margin:0 1em 0.5em; font-size:0.85em;";
  PAGES.forEach(([path, label], i) => {
    if (i > 0) nav.append(" · ");
    const url = new URL(path, base);
    if (url.pathname === here || (path === "index.html" && here === base.pathname)) {
      const b = document.createElement("b");
      b.textContent = label;
      nav.append(b);
    } else {
      const a = document.createElement("a");
      a.href = url.href;
      a.textContent = label;
      nav.append(a);
    }
  });

  const container = document.querySelector("#container");
  container.insertBefore(nav, container.firstChild);
})();
