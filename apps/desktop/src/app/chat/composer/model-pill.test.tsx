import { act, cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatBarState } from '@/app/chat/composer/types'
import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { $activeSessionId, $currentModel, setCurrentModel, setCurrentModelSource } from '@/store/session'

import { MODEL_RESOLVE_GRACE_MS, ModelPill } from './model-pill'

const modelState = (over: Partial<ChatBarState['model']> = {}): ChatBarState['model'] => ({
  canSwitch: true,
  model: 'gpt-6',
  provider: 'openai',
  ...over
})

afterEach(() => {
  cleanup()
  $activeSessionId.set(null)
  setCurrentModel('')
  setCurrentModelSource('')
})

// #62055: a manual composer pick is sticky and silently overrides the
// Settings → Model default for every NEW chat. The pill must say so.
describe('ModelPill pinned-override badge', () => {
  it('shows the pin dot on a draft running a manual pick', () => {
    setCurrentModel('deepseek/deepseek-v4-flash')
    setCurrentModelSource('manual')
    $activeSessionId.set(null)

    render(<ModelPill disabled={false} model={modelState({ model: 'deepseek/deepseek-v4-flash' })} />)

    expect(screen.getByTestId('model-pinned-dot')).toBeTruthy()
  })

  it('stays quiet when the composer reflects the profile default', () => {
    setCurrentModel('google/gemma-4-26b-a4b-it:free')
    setCurrentModelSource('default')
    $activeSessionId.set(null)

    render(<ModelPill disabled={false} model={modelState()} />)

    expect(screen.queryByTestId('model-pinned-dot')).toBeNull()
  })

  it('stays quiet on a live session (footer shows that session, not the pin)', () => {
    setCurrentModel('deepseek/deepseek-v4-flash')
    setCurrentModelSource('manual')
    $activeSessionId.set('live-1')

    render(<ModelPill disabled={false} model={modelState()} />)

    expect(screen.queryByTestId('model-pinned-dot')).toBeNull()
  })

  it('is exercised in both render paths', () => {
    setCurrentModel('deepseek/deepseek-v4-flash')
    setCurrentModelSource('manual')
    $activeSessionId.set(null)

    // Fallback (no live menu) path.
    const { unmount } = render(
      <ModelPill disabled={false} model={modelState({ model: 'deepseek/deepseek-v4-flash' })} />
    )

    expect(screen.getByTestId('model-pinned-dot')).toBeTruthy()
    unmount()

    // Live-menu (dropdown) path.
    render(
      <ModelPill
        disabled={false}
        model={modelState({ model: 'deepseek/deepseek-v4-flash', modelMenuContent: <div /> })}
      />
    )
    expect(screen.getByTestId('model-pinned-dot')).toBeTruthy()
    expect($currentModel.get()).toBe('deepseek/deepseek-v4-flash')
  })
})

describe('ModelPill per-surface model label', () => {
  it('shows the chat-bar model even when the primary global differs', () => {
    setCurrentModel('primary/model')
    $activeSessionId.set('primary-runtime')

    const tileView: SessionView = {
      kind: 'tile',
      $awaitingResponse: atom(false),
      $busy: atom(false),
      $cwd: atom(''),
      $fast: atom(false),
      $lastVisibleIsUser: atom(false),
      $messages: atom([]),
      $messagesEmpty: atom(true),
      $model: atom('tile/claude-sonnet'),
      $provider: atom('anthropic'),
      $reasoningEffort: atom('high'),
      $runtimeId: atom('tile-runtime'),
      $storedId: atom('stored-tile'),
      $turnStartedAt: atom<number | null>(null)
    }

    render(
      <SessionViewProvider value={tileView}>
        <ModelPill
          disabled={false}
          model={modelState({ model: 'tile/claude-sonnet', provider: 'anthropic', modelMenuContent: <div /> })}
        />
      </SessionViewProvider>
    )

    expect(screen.getByText('Sonnet · High')).toBeTruthy()
    expect(screen.queryByText(/primary/i)).toBeNull()
  })
})

// #93892: the pill's loader used to spin for as long as the surface had no
// model — with no timer, error or retry cap. It is now a bounded grace per
// surface identity, after which the pill admits "no model" and stays usable.
describe('ModelPill bounded loader', () => {
  const tileView = (runtimeId: string, model = ''): SessionView => ({
    kind: 'tile',
    $awaitingResponse: atom(false),
    $busy: atom(false),
    $cwd: atom(''),
    $fast: atom(false),
    $lastVisibleIsUser: atom(false),
    $messages: atom([]),
    $messagesEmpty: atom(true),
    $model: atom(model),
    $provider: atom(''),
    $reasoningEffort: atom(''),
    $runtimeId: atom(runtimeId),
    $storedId: atom('stored-tile'),
    $turnStartedAt: atom<number | null>(null)
  })

  const renderEmptyPill = (view: SessionView) =>
    render(
      <SessionViewProvider value={view}>
        <ModelPill disabled={false} model={modelState({ model: '', provider: '', modelMenuContent: <div /> })} />
      </SessionViewProvider>
    )

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spins only for the grace window, then shows the empty label', () => {
    vi.useFakeTimers()
    renderEmptyPill(tileView('rt-1'))

    expect(screen.queryByTestId('model-pill-no-model')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(MODEL_RESOLVE_GRACE_MS - 1)
    })
    expect(screen.queryByTestId('model-pill-no-model')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByTestId('model-pill-no-model').textContent).toBe('no model')
  })

  it('does not re-arm the loader when the runtime is rebound (reclaim → resume)', () => {
    vi.useFakeTimers()
    const view = tileView('rt-1')
    renderEmptyPill(view)

    act(() => {
      vi.advanceTimersByTime(MODEL_RESOLVE_GRACE_MS)
    })
    expect(screen.getByTestId('model-pill-no-model')).toBeTruthy()

    // The loop's signature: same stored session, a fresh runtime every cycle.
    act(() => {
      ;(view.$runtimeId as ReturnType<typeof atom<null | string>>).set('rt-2')
    })

    expect(screen.getByTestId('model-pill-no-model')).toBeTruthy()
  })

  it('paints the model as soon as one lands, before or after the grace', () => {
    vi.useFakeTimers()
    const view = tileView('rt-1')
    renderEmptyPill(view)

    act(() => {
      vi.advanceTimersByTime(MODEL_RESOLVE_GRACE_MS)
    })
    expect(screen.getByTestId('model-pill-no-model')).toBeTruthy()

    act(() => {
      ;(view.$model as ReturnType<typeof atom<string>>).set('tile/claude-sonnet')
    })

    expect(screen.queryByTestId('model-pill-no-model')).toBeNull()
    expect(screen.getByText(/^Sonnet/)).toBeTruthy()
  })
})
