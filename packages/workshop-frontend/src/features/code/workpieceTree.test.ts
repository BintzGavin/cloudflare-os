import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@gadgets/workshop-shared/api'
import {
  ancestorDirs, browserTreePaths, buildBrowserTree, deriveChanges, fileChangeStatus,
  type BrowserNode,
} from './workpieceTree'

const BASE: TreeNode[] = [
  { name: 'README.md', kind: 'file' },
  { name: 'bin', kind: 'dir', children: [{ name: 'run', kind: 'executable' }] },
  { name: 'src', kind: 'dir', children: [
    { name: 'a.ts', kind: 'file' },
    { name: 'lib', kind: 'dir', children: [{ name: 'util.ts', kind: 'file' }] },
    { name: 'link', kind: 'symlink' },
  ] },
  { name: 'vendor', kind: 'submodule' },
]

// A compact rendering of the tree for assertions: directories end in '/', children indented.
function render(nodes: readonly BrowserNode[], depth = 0): string[] {
  const out: string[] = []
  for (const node of nodes) {
    const indent = '  '.repeat(depth)
    if (node.kind === 'dir') {
      out.push(`${indent}${node.name}/`)
      out.push(...render(node.children, depth + 1))
    } else {
      out.push(`${indent}${node.name}${node.kind === 'file' ? '' : ` (${node.kind})`}`)
    }
  }
  return out
}

describe('buildBrowserTree', () => {
  it('lists the base with directories first, then leaves, each by name', () => {
    const tree = buildBrowserTree(BASE, [], new Set())
    expect(render(tree.roots)).toEqual([
      'bin/',
      '  run (executable)',
      'src/',
      '  lib/',
      '    util.ts',
      '  a.ts',
      '  link (symlink)',
      'README.md',
      'vendor (submodule)',
    ])
    expect(tree.leaves.get('bin/run')).toBe('executable')
    expect(tree.leaves.get('src/link')).toBe('symlink')
    expect(tree.leaves.get('vendor')).toBe('submodule')
    expect(tree.leaves.get('README.md')).toBe('file')
  })

  it('removes tombstoned leaves and drops directories left empty', () => {
    const tree = buildBrowserTree(BASE, [], new Set(['src/lib/util.ts', 'bin/run']))
    expect(render(tree.roots)).toEqual([
      'src/',
      '  a.ts',
      '  link (symlink)',
      'README.md',
      'vendor (submodule)',
    ])
    expect(tree.leaves.has('src/lib/util.ts')).toBe(false)
  })

  it('inserts overlay paths the base lacks, with virtual ancestors', () => {
    const tree = buildBrowserTree(BASE, ['docs/guide/intro.md', 'src/b.ts', 'zzz'], new Set())
    expect(render(tree.roots)).toEqual([
      'bin/',
      '  run (executable)',
      'docs/',
      '  guide/',
      '    intro.md',
      'src/',
      '  lib/',
      '    util.ts',
      '  a.ts',
      '  b.ts',
      '  link (symlink)',
      'README.md',
      'vendor (submodule)',
      'zzz',
    ])
    expect(tree.leaves.get('docs/guide/intro.md')).toBe('file')
  })

  it('keeps the base kind of a present path that names an existing leaf', () => {
    const tree = buildBrowserTree(BASE, ['bin/run'], new Set())
    expect(tree.leaves.get('bin/run')).toBe('executable')
  })

  it('a present path wins over a removal of the same path', () => {
    // The caller keeps these disjoint, but a set beats a tombstone if they ever overlap.
    const tree = buildBrowserTree(BASE, ['README.md'], new Set(['README.md']))
    expect(tree.leaves.has('README.md')).toBe(true)
  })

  it('is the overlay alone with no base', () => {
    const tree = buildBrowserTree(null, ['client.js', 'server.js'], new Set())
    expect(render(tree.roots)).toEqual(['client.js', 'server.js'])
  })

  it('ignores removals of paths the base lacks', () => {
    const tree = buildBrowserTree(BASE, [], new Set(['nope', 'src/nope/x']))
    expect(browserTreePaths(tree.roots)).toEqual(browserTreePaths(buildBrowserTree(BASE, [], new Set()).roots))
  })
})

describe('browserTreePaths', () => {
  it('flattens leaves in display order', () => {
    const tree = buildBrowserTree(BASE, [], new Set())
    expect(browserTreePaths(tree.roots)).toEqual([
      'bin/run', 'src/lib/util.ts', 'src/a.ts', 'src/link', 'README.md', 'vendor',
    ])
  })
})

describe('ancestorDirs', () => {
  it('names each directory above the path', () => {
    expect(ancestorDirs('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(ancestorDirs('top.ts')).toEqual([])
  })
})

describe('fileChangeStatus', () => {
  it('is unknown while the review base read is in flight', () => {
    expect(fileChangeStatus('x', undefined, true)).toBeUndefined()
  })

  it('treats every displayed file as added when there is no review base', () => {
    expect(fileChangeStatus('x', undefined, false)).toBe('added')
    expect(fileChangeStatus(null, undefined, false)).toBe('unchanged')
  })

  it('compares against the review base', () => {
    expect(fileChangeStatus('x', { absent: true }, true)).toBe('added')
    expect(fileChangeStatus(null, { absent: true }, true)).toBe('unchanged')
    expect(fileChangeStatus(null, { text: 'x' }, true)).toBe('deleted')
    expect(fileChangeStatus('y', { text: 'x' }, true)).toBe('modified')
    expect(fileChangeStatus('x', { text: 'x' }, true)).toBe('unchanged')
    expect(fileChangeStatus('x', { unreadable: 'binary' }, true)).toBe('modified')
  })
})

describe('deriveChanges', () => {
  const display = new Map<string, string | null>([
    ['kept.ts', 'same'], ['edited.ts', 'new'], ['new.ts', 'x'], ['gone.ts', null], ['never.ts', null],
  ])
  const displayed = (path: string) => display.get(path)

  it('lists every status but unchanged, in path order', () => {
    const originals = new Map([
      ['kept.ts', { text: 'same' }], ['edited.ts', { text: 'old' }], ['new.ts', { absent: true }],
      ['gone.ts', { text: 'was' }], ['never.ts', { absent: true }],
    ] as const)
    const { statuses, changes } = deriveChanges([...display.keys()], displayed, originals, true)
    expect(changes).toEqual([
      { path: 'edited.ts', status: 'modified' },
      { path: 'new.ts', status: 'added' },
      { path: 'gone.ts', status: 'deleted' },
    ])
    expect(statuses.get('kept.ts')).toBe('unchanged')
    expect(statuses.get('never.ts')).toBe('unchanged')
  })

  it('keeps an unresolved removal listed as pending, and nothing else unresolved', () => {
    // Nothing has loaded from the review base yet: a removed path is listed nowhere else, so
    // it must stay selectable here; present paths are in the tree and can wait for a status.
    const { statuses, changes } = deriveChanges([...display.keys()], displayed, new Map(), true)
    expect(changes).toEqual([
      { path: 'gone.ts', status: 'pending' },
      { path: 'never.ts', status: 'pending' },
    ])
    expect(statuses.size).toBe(0)
  })

  it('needs no review base for a pending gadget', () => {
    const { changes } = deriveChanges([...display.keys()], displayed, new Map(), false)
    expect(changes).toEqual([
      { path: 'kept.ts', status: 'added' },
      { path: 'edited.ts', status: 'added' },
      { path: 'new.ts', status: 'added' },
    ])
  })
})
