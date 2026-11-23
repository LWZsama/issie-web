import { acceleratorOf, menuItemsFor } from "issie/menus";

export function contextMenu(isMac) {
  let x = 0, y = 0, selected, visible;
  window.addEventListener("contextmenu", event => { x = event.clientX; y = event.clientY; }, true);
  function dismiss() { visible?.remove(); visible = null; }
  window.addEventListener("pointerdown", event => { if (!visible?.contains(event.target)) dismiss(); }, true);
  window.addEventListener("blur", dismiss);
  return {
    onContextMenuCommand(callback) { selected = callback; },
    showContextMenu(kind) {
      dismiss();
      const items = menuItemsFor(kind);
      if (!items.length) return;
      const menu = document.createElement("div");
      menu.className = "dropdown-content"; menu.setAttribute("role", "menu");
      Object.assign(menu.style, { position: "fixed", zIndex: 99999, minWidth: "13em" });
      for (const label of items) {
        const item = document.createElement("button");
        item.type = "button"; item.className = "dropdown-item"; item.setAttribute("role", "menuitem");
        item.textContent = label;
        Object.assign(item.style, { display: "flex", justifyContent: "space-between", gap: "1em", cursor: "pointer" });
        const shortcut = acceleratorOf(label);
        if (shortcut) {
          const key = document.createElement("kbd"); key.textContent = shortcut[isMac ? 1 : 0]; item.append(key);
        }
        item.onclick = () => { dismiss(); selected?.(kind + "," + label); };
        menu.append(item);
      }
      menu.onkeydown = event => {
        if (event.key === "Escape") { event.preventDefault(); dismiss(); return; }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault(); event.stopPropagation();
        const buttons = Array.from(menu.children);
        const step = event.key === "ArrowDown" ? 1 : -1;
        buttons[(buttons.indexOf(document.activeElement) + step + buttons.length) % buttons.length].focus();
      };
      document.body.append(menu); visible = menu;
      menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth)) + "px";
      menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight)) + "px";
      menu.firstElementChild.focus();
    },
  };
}
