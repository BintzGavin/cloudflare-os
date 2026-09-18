// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatMessage, AiChatSubscriber, Overseer } from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const Null = () => null
  const parts = new Proxy(Pass, {
    get: (_target, property) => property === 'Root' ? Null : Pass,
  })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return {
    ...actual,
    Dialog: parts,
    DropdownMenu: parts,
    Popover: parts,
    Tooltip: Pass,
    useKumoToastManager: () => toasts,
  }
})

vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [] },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface from './ChatInterface'
import { linkActionLog } from './useActions'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

function withChatApi(
  server: ReturnType<typeof makeOverseer>,
  getChatMessage = vi.fn<(chatId: number, sequence: number) => Promise<AiChatMessage | null>>(),
) {
  let subscriber: AiChatSubscriber | undefined
  Object.assign(server.overseer as object, {
    getChatMessage,
    listChats: async () => [],
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
  })
  return {
    getChatMessage,
    emitMessage(message: AiChatMessage) {
      act(() => subscriber!.message(message))
    },
  }
}

function renderChat(overseer: RpcStub<Overseer>, selectedChatId: number | null = null) {
  return testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      selectedChatId={selectedChatId}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
  )
}

const actionMessage = {
  chatId: 1,
  sequence: 0,
  timestamp: new Date(),
  author: { type: 'agent', id: 'model', name: 'Model' },
  type: 'action',
  actionId: 1,
  actionLog: entry(1),
} as AiChatMessage

const resolvedMessage =
  { ...actionMessage, actionLog: entry(1, { state: 'approved' }) } as AiChatMessage

// Renders a first session that caches a pending action card, then settles it so a linked swap
// can resume. Pass a key to link the stub; unlinked sessions never park a watermark.
async function cachePendingCard(key?: string) {
  const first = makeOverseer()
  const firstChat = withChatApi(first)
  if (key !== undefined) linkActionLog(first.overseer, key)
  await renderChat(first.overseer)
  await first.resolveSubscription()
  await first.resolvePendingQuery({ entries: [entry(1)] })
  firstChat.emitMessage(actionMessage)
}

describe('ChatInterface action refresh', () => {
  it('refetches cached mutable cards when an unlinked stub swaps', async () => {
    await cachePendingCard()

    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => resolvedMessage))
    await renderChat(second.overseer)
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
  })

  it('skips the cached-card refetch on a resumed linked stub swap', async () => {
    await cachePendingCard('ws-chat-resume')

    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => resolvedMessage))
    linkActionLog(second.overseer, 'ws-chat-resume')
    await renderChat(second.overseer)
    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [entry(1)] })
    expect(secondChat.getChatMessage).not.toHaveBeenCalled()
  })
})

it('opens a recorded code-result image and restores focus when its preview closes', async () => {
  const originalUrl = URL
  const createUrl = vi.fn<(blob: Blob) => string>(() => 'blob:recorded-image')
  const revokeUrl = vi.fn<(url: string) => void>()
  const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn<() => void>() })
  vi.stubGlobal('URL', class extends originalUrl {
    static createObjectURL = createUrl
    static revokeObjectURL = revokeUrl
  })
  try {
    const server = makeOverseer()
    withChatApi(server)
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const message: AiChatMessage = {
      type: 'message', chatId: 1, sequence: 0, timestamp: new Date(),
      author: { type: 'agent', id: 'model', name: 'Model' }, message: '',
      toolCalls: [{
        toolCallId: 'capture', toolName: 'executeCode', input: { code: 'return capture;' },
        output: 'Captured.', attachments: [{
          id: 'image', mimeType: 'image/png', name: 'capture.png', size: image.length, content: image,
        }],
      }],
    }
    Object.assign(server.overseer as object, {
      listChats: async () => [{ id: 1, title: 'Images', started: new Date(), lastActive: new Date() }],
      getChatHistory: async () => ({ messages: [message] }),
    })
    await renderChat(server.overseer, 1)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    flushFrames()
    const run = [...document.querySelectorAll('button')].find(button => button.textContent === 'Ran code return capture;')
    expect(run).toBeDefined()
    act(() => run!.click())
    const preview = document.querySelector<HTMLButtonElement>('[aria-label="Preview capture.png"]')
    expect(preview).not.toBeNull()
    expect(preview!.querySelector('img')?.getAttribute('src')).toBe('blob:recorded-image')
    preview!.focus()
    act(() => preview!.click())
    flushFrames()
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('blob:recorded-image')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close preview')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(preview)
    expect(createUrl.mock.calls[0][0]).toMatchObject({ size: image.length, type: 'image/png' })
    testRoot.unmount()
    expect(revokeUrl).toHaveBeenCalled()
  } finally {
    vi.stubGlobal('URL', originalUrl)
    if (scrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  }
})
