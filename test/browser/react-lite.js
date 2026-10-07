/**
 * A minimal React implementation, just enough to mount the client bundle's
 * components in a REAL browser DOM.
 *
 * This is deliberately not a React reimplementation. It supports exactly what
 * `lib/client.js` uses: `createElement`, `Fragment`, `useState`, `useReducer`,
 * `useRef`, `useMemo`, `useCallback`, `useEffect` and `useSyncExternalStore`,
 * and it walks function components recursively so that a component rendered by
 * another component (the overlay → `CreateFlow`) actually mounts and runs its
 * effects. Host elements (`'div'`, `'button'`, …) are NOT turned into DOM — the
 * bundle's own DOM work is done by its `MutationObserver` path against the
 * fixture markup, which is what the harness verifies. A host element is walked
 * only so the components inside it mount.
 *
 * Limits, stated plainly so no assertion here is read as more than it is:
 *   - no host DOM, no diffing, no keys, no context, no memo, no error boundary;
 *   - children are re-mounted only when their position in the tree changes;
 *   - state updates during a render are queued and flushed after it.
 *
 * Frames are keyed by their path in the vnode tree, so a re-render of one
 * component cannot clobber another's hook state.
 */

const RENDERING = Symbol('rendering')

function createRoot() {
  return { frames: new Map(), rendering: false, dirty: new Set(), cleanups: [] }
}

/* ------------------------------------------------------------------ *
 * Hooks. Each captures its own frame, so an event handler or a store
 * notification re-renders the right component.
 * ------------------------------------------------------------------ */

let current = null

function slot(initial) {
  const frame = current
  const index = frame.cursor
  frame.cursor += 1
  if (frame.hooks[index] === undefined) {
    frame.hooks[index] = { value: typeof initial === 'function' ? initial() : initial, deps: undefined }
  }
  return frame.hooks[index]
}

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((value, i) => Object.is(value, b[i]))
}

function React$createElement(type, props, ...children) {
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  return { type, props: Object.assign({}, props, { children: flat }), children: flat }
}

const React = {
  Fragment: Symbol.for('react.fragment'),
  createElement: React$createElement,

  useState(initial) {
    const frame = current
    const entry = slot(initial)
    return [
      entry.value,
      (next) => {
        entry.value = typeof next === 'function' ? next(entry.value) : next
        scheduleRerender(frame)
      },
    ]
  },

  useReducer(reducer, initial) {
    const frame = current
    const entry = slot(initial)
    return [
      entry.value,
      (action) => {
        entry.value = reducer(entry.value, action)
        scheduleRerender(frame)
      },
    ]
  },

  useRef(initial) {
    return slot({ current: initial }).value
  },

  useMemo(fn, deps) {
    const entry = slot(undefined)
    if (!sameDeps(entry.deps, deps)) {
      entry.value = fn()
      entry.deps = deps
    }
    return entry.value
  },

  useCallback(fn, deps) {
    return React.useMemo(() => fn, deps)
  },

  useEffect(fn, deps) {
    const entry = slot(undefined)
    if (!sameDeps(entry.deps, deps)) {
      entry.deps = deps
      entry.effect = fn
      entry.ran = false
    }
  },

  useSyncExternalStore(subscribe, getSnapshot) {
    const frame = current
    const entry = slot(undefined)
    entry.value = getSnapshot()
    const wiring = slot(undefined)
    if (wiring.unsubscribe === undefined) {
      wiring.unsubscribe = subscribe(() => scheduleRerender(frame))
    }
    return entry.value
  },
}

/* ------------------------------------------------------------------ *
 * The tree walk.
 * ------------------------------------------------------------------ */

function scheduleRerender(frame) {
  const root = frame.root
  if (root.rendering) {
    root.dirty.add(frame)
    return
  }
  rerender(frame)
}

function rerender(frame) {
  const root = frame.root
  root.rendering = true
  try {
    do {
      root.dirty.clear()
      renderFrame(frame)
      walk(frame.tree, frame.path + '/', root)
    } while (root.dirty.size > 0)
  } finally {
    root.rendering = false
  }
}

function renderFrame(frame) {
  frame.cursor = 0
  const previous = current
  current = frame
  try {
    frame.tree = frame.component(frame.props)
  } finally {
    current = previous
  }
  // Effects run after the render that scheduled them.
  for (const entry of frame.hooks) {
    if (entry !== undefined && typeof entry.effect === 'function' && entry.ran !== true) {
      entry.ran = true
      if (typeof entry.cleanup === 'function') entry.cleanup()
      const cleanup = entry.effect()
      entry.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }
}

function frameAt(root, path, type, props) {
  const existing = root.frames.get(path)
  if (existing !== undefined && existing.component === type) {
    existing.props = props
    return existing
  }
  if (existing !== undefined) unmountFrame(existing)
  const frame = { root, path, component: type, props, hooks: [], cursor: 0, tree: null }
  root.frames.set(path, frame)
  return frame
}

function unmountFrame(frame) {
  for (const entry of frame.hooks) {
    if (entry !== undefined && typeof entry.cleanup === 'function') entry.cleanup()
    if (entry !== undefined && typeof entry.unsubscribe === 'function') entry.unsubscribe()
  }
  for (const [path, candidate] of frame.root.frames) {
    if (path.startsWith(frame.path + '/')) {
      unmountFrame(candidate)
      frame.root.frames.delete(path)
    }
  }
}

/** Walk a vnode tree, mounting every function component it contains. */
function walk(vnode, path, root) {
  if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return
  if (typeof vnode === 'string' || typeof vnode === 'number') return
  if (Array.isArray(vnode)) {
    vnode.forEach((child, i) => walk(child, path + i + ',', root))
    return
  }
  if (typeof vnode !== 'object' || vnode.type === undefined) return

  const { type, props } = vnode
  if (type === React.Fragment) {
    walk(props.children, path, root)
    return
  }
  if (typeof type === 'function') {
    const frame = frameAt(root, path, type, props)
    renderFrame(frame)
    walk(frame.tree, path + '/', root)
    return
  }
  // A host element: not rendered to DOM, but its children still mount.
  walk(props.children, path + '<', root)
}

/** Walk one vnode tree, collecting matches. Does not cross into child frames. */
function collect(vnode, predicate, hits) {
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return
  if (Array.isArray(vnode)) {
    for (const child of vnode) collect(child, predicate, hits)
    return
  }
  if (vnode.type === undefined) return
  if (typeof vnode.type !== 'function' && predicate(vnode)) hits.push(vnode)
  collect(vnode.props?.children, predicate, hits)
}

/**
 * Mount a component tree.
 *
 * @returns an object with the root frame, `rerender()`, `find(component)` to
 *          reach a mounted frame by component identity, `search(predicate)` to
 *          find a rendered HOST vnode anywhere in the tree (every mounted frame
 *          is searched, because a child component's output lives in its own
 *          frame rather than being spliced into its parent's tree), and
 *          `unmount()`.
 */
React.mount = function mount(component, props) {
  const root = createRoot()
  const frame = frameAt(root, 'root', component, props)
  rerender(frame)
  return {
    root,
    frame,
    get tree() { return frame.tree },
    rerender: () => rerender(frame),
    /** Every mounted frame whose component is `type`. */
    find: (type) => [...root.frames.values()].filter((f) => f.component === type),
    /** The rendered tree of the first mounted instance of `type`. */
    treeOf(type) {
      const found = this.find(type)[0]
      return found === undefined ? null : found.tree
    },
    /** Every rendered host vnode matching `predicate`, across all frames. */
    search(predicate) {
      const hits = []
      for (const candidate of root.frames.values()) collect(candidate.tree, predicate, hits)
      return hits
    },
    unmount() {
      unmountFrame(frame)
      root.frames.clear()
    },
  }
}

export default React
