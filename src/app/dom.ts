/**
 * The smallest DOM helpers that pay for themselves.
 *
 * Deliberately not a framework and not a virtual DOM: this is `createElement`
 * with a nicer signature. Everything that renders in this app builds real nodes
 * and mutates them in place, because the one thing the list must never do is
 * rebuild itself from a string.
 */

type Attrs = Record<string, string | number | boolean | null | undefined>
type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  applyAttrs(node, attrs)
  append(node, children)
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export function svg(tag: string, attrs: Attrs = {}, children: Element[] = []): SVGElement {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    node.setAttribute(key, String(value))
  }
  for (const child of children) node.appendChild(child)
  return node
}

export function applyAttrs(node: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) {
      node.removeAttribute(key)
      continue
    }
    if (value === true) {
      node.setAttribute(key, '')
      continue
    }
    node.setAttribute(key, String(value))
  }
}

export function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

/** Set text only when it differs, so the browser skips a needless layout. */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

export function setClass(node: Element, name: string, on: boolean): void {
  node.classList.toggle(name, on)
}

/** `setAttr(node, 'aria-current', condition && 'page')` reads better than a branch. */
export function setAttr(node: Element, name: string, value: string | null | false): void {
  if (value === null || value === false) node.removeAttribute(name)
  else if (node.getAttribute(name) !== value) node.setAttribute(name, value)
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function query<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (!found) throw new Error(`missing element: ${selector}`)
  return found
}

/**
 * Reorder `parent`'s children to match `desired`, moving existing nodes rather
 * than replacing them.
 *
 * Nodes carrying `data-leaving` are left where they are: they are mid-exit
 * animation and their model row is already gone. Everything else not in
 * `desired` is removed.
 */
export function reconcile(parent: Element, desired: readonly Element[]): void {
  const wanted = new Set(desired)

  for (const child of [...parent.children]) {
    if (!wanted.has(child) && !(child instanceof HTMLElement && child.dataset.leaving !== undefined)) {
      child.remove()
    }
  }

  let cursor: Element | null = parent.firstElementChild
  for (const node of desired) {
    // Skip over any exiting node holding its place.
    while (cursor instanceof HTMLElement && cursor.dataset.leaving !== undefined && cursor !== node) {
      cursor = cursor.nextElementSibling
    }
    if (cursor === node) {
      cursor = cursor.nextElementSibling
      continue
    }
    parent.insertBefore(node, cursor)
  }
}
